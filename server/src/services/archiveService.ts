import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { closeSync, mkdirSync, openSync, fsyncSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";
import { encryptBuffer, decryptBuffer } from "../utils/backupCrypto.js";

/**
 * Denetim kaydi ve olcum tablolarinin arsivlenmesi (gorev #153).
 *
 * PROBLEM: audit_log, fuel_tank_readings ve station_sync_events sinirsiz buyur. Bin
 * istasyonluk bir kurulumda tank olcumu tek basina saatte 3.000 satir - yilda ~26 milyon.
 * Denetim kaydi her giris, her fiyat degisikligi, her CSV disa aktarimi icin bir satir.
 * Hicbiri temizlenmiyordu; buyume "bir gun yavaslar" degil, "bir gun disk dolar"dir.
 *
 * NEDEN SILMIYORUZ: bu tablolar tam olarak silinmemesi gereken tablolar. Denetim kaydi
 * adli/mali bir kanittir - "o fiyati kim degistirdi" sorusunun tek cevabi. Tank olcumu bir
 * kacak sorusturmasinin dayanagidir. Eski diye atilan bir satir, gerektiginde geri
 * getirilemez.
 *
 * COZUM: satirlar SILINMEZ, TASINIR. Sifreli bir NDJSON.gz dosyasina yazilir, dosya diskten
 * GERI OKUNUP dogrulanir ve ancak ondan sonra canli tablodan dusulur.
 *
 * DEGISMEZ KURAL: hicbir satir, dogrulanmis bir arsiv dosyasinda oldugu ISPATLANMADAN
 * silinmez. Sira bilerek boyle: yaz -> fsync -> geri oku -> karsilastir -> sil. Surec
 * ortada olurse en kotu ihtimalle FAZLADAN bir arsiv dosyasi kalir (icindeki satirlar
 * hala canli); bir sonraki tarama ayni satirlari yeniden arsivler. Hata yonu her zaman
 * "fazla veri"dir, asla "eksik veri".
 *
 * YEDEKTEN FARKI: yedekler rotasyona tabidir (BACKUP_RETENTION_COUNT), eskisi silinir -
 * cunku her yedek veritabaninin TAMAMIDIR, yenisi eskisini kapsar. Arsiv dosyalari
 * ROTASYONA TABI DEGILDIR: her biri artik baska hicbir yerde olmayan satirlarin TEK
 * kopyasidir. Silinirse veri gider.
 */

/** Bir taramada bir tablodan en fazla kac satir tasinir.
 *
 * Tavan olmasaydi ilk tarama milyonlarca satiri tek islemde silmeye calisir, SQLite
 * yazma kilidini dakikalarca tutar ve bu sirada gelen her kiosk islemi beklerdi.
 * Birikmis gecmis birkac taramaya yayilarak erir; acele edecek bir sey yok. */
const BATCH_LIMIT = 20_000;

/** DELETE ifadesindeki `?` sayisi. SQLite'in degisken sinirinin cok altinda tutuluyor. */
const DELETE_CHUNK = 500;

export interface ArchivableTable {
  table: string;
  /** Satirin YASINI belirleyen kolon - her tabloda ayni ada sahip degil. */
  timestampColumn: string;
  /** Bu yastan eski satirlar arsive tasinir. */
  retentionMonths: number;
  /** Yapilandirma bunun altina inemez (bkz. resolveRetentionMonths). */
  minRetentionMonths: number;
  /** Ortam degiskeniyle ozellestirme anahtari. */
  envKey: "ARCHIVE_AUDIT_LOG_MONTHS" | "ARCHIVE_TANK_READING_MONTHS" | "ARCHIVE_SYNC_EVENT_MONTHS";
  label: string;
}

/**
 * Arsivlenen tablolar.
 *
 * Ucunun de ORTAK ozelligi var: hicbirine baska bir tablodan yabanci anahtar BAKMIYOR.
 * Bu tesaduf degil, secim olcutu: bir satiri canli tablodan dusurmek, ona referans veren
 * baska bir satiri yetim birakmamali.
 *
 * transactions VE alarms bu yuzden BILEREK LISTEDE DEGIL - bkz. dosyanin sonundaki not.
 */
const ARCHIVABLE: ArchivableTable[] = [
  {
    table: "audit_log",
    timestampColumn: "created_at",
    // 24 ay: isletmenin "gecen yil bu islemi kim yapmisti" sorusunu cevaplayabilecegi
    // kadar uzun. Bu bir HUKUKI sayi degil, isletme varsayilani - saklama politikasi
    // avukatla netlesince ARCHIVE_AUDIT_LOG_MONTHS ile degistirilmeli (bkz. BEKLEYENLER.md).
    retentionMonths: 24,
    minRetentionMonths: 12,
    envKey: "ARCHIVE_AUDIT_LOG_MONTHS",
    label: "Denetim kaydi",
  },
  {
    table: "fuel_tank_readings",
    timestampColumn: "measured_at",
    // 12 ay: sapma hesabi yalnizca BIR ONCEKI olcume bakar (bkz. fuelVarianceService),
    // yani eski olcumleri tasimak gunluk calismayi etkilemez. Etkiledigi tek sey yillik
    // sapma grafigi - onun icin bir yil yeterli.
    retentionMonths: 12,
    minRetentionMonths: 6,
    envKey: "ARCHIVE_TANK_READING_MONTHS",
    label: "Tank seviye olcumleri",
  },
  {
    table: "station_sync_events",
    timestampColumn: "received_at",
    // 3 ay: ajan telemetrisi. Bir senkron sorununu teshis etme penceresi gunler, en fazla
    // haftalardir; uc ay fazlasiyla comert.
    retentionMonths: 3,
    minRetentionMonths: 1,
    envKey: "ARCHIVE_SYNC_EVENT_MONTHS",
    label: "Ajan senkron olaylari",
  },
];

/**
 * Yapilandirilan sureyi tabanla kirpar.
 *
 * Yanlislikla girilen bir "1", geri donulemez sekilde iki yillik denetim kaydini diskten
 * cikarirdi. Degeri REDDETMEK yerine TABANA CEKIYORUZ ve logluyoruz: sunucunun bir yapilandirma
 * hatasi yuzunden hic acilmamasi, arsivlemenin biraz fazla veri tutmasindan daha kotudur.
 */
function resolveRetentionMonths(spec: ArchivableTable): number {
  const raw = env[spec.envKey];
  if (raw === undefined || raw === null) return spec.retentionMonths;
  if (!Number.isFinite(raw) || raw < spec.minRetentionMonths) {
    logger.warn(
      { table: spec.table, requested: raw, floor: spec.minRetentionMonths },
      "Arsiv saklama suresi tabanin altinda - taban degeri kullanilacak."
    );
    return spec.minRetentionMonths;
  }
  return raw;
}

function cutoffFor(retentionMonths: number, now: Date): string {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return cutoff.toISOString();
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface ArchivableRow {
  id: number;
  [key: string]: unknown;
}

export interface ArchivedTableResult {
  table: string;
  label: string;
  cutoff: string;
  rowCount: number;
  fileName: string | null;
  /** Esikten eski AMA bu taramada sirasi gelmemis satir sayisi (BATCH_LIMIT tavani). */
  remaining: number;
}

export interface ArchiveRunResult {
  enabled: boolean;
  tables: ArchivedTableResult[];
  totalRows: number;
}

/**
 * Satirlari NDJSON'a cevirir: her satir tek basina gecerli bir JSON nesnesi.
 *
 * Tek bir dev JSON dizisi yerine NDJSON, cunku arsiv dosyasi yillar sonra, muhtemelen bu
 * kod artik calismazken okunacak: NDJSON'i `zcat | jq` ile satir satir okumak icin ozel
 * bir arac gerekmez ve dosyanin tamamini bellege almak gerekmez.
 */
function toNdjson(rows: ArchivableRow[]): Buffer {
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

function parseNdjson(buf: Buffer): ArchivableRow[] {
  return buf
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArchivableRow);
}

/** Dosyayi once gecici bir ada yazip fsync'ler, sonra son adina tasir.
 *
 * Yarim yazilmis bir dosyanin gecerli bir arsiv gibi gorunmesi, arsivlemenin yapabilecegi
 * en kotu sey olurdu: dogrulama gecer gibi durur, satirlar silinir, dosya bozuktur.
 * rename() ayni dosya sisteminde atomiktir - dosya ya tam haliyle vardir ya hic yoktur. */
function writeArchiveFile(dir: string, fileName: string, payload: Buffer): void {
  const finalPath = join(dir, fileName);
  const tmpPath = join(dir, `.tmp-${fileName}`);
  writeFileSync(tmpPath, payload);
  const fd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Tek bir tabloyu arsivler. Dosya yazilip DOGRULANMADAN hicbir satir silinmez.
 */
function archiveTable(spec: ArchivableTable, dir: string, now: Date): ArchivedTableResult {
  const retentionMonths = resolveRetentionMonths(spec);
  const cutoff = cutoffFor(retentionMonths, now);
  const base: ArchivedTableResult = {
    table: spec.table,
    label: spec.label,
    cutoff,
    rowCount: 0,
    fileName: null,
    remaining: 0,
  };

  // Tablo/kolon adlari bu dosyadaki sabit listeden gelir, kullanici girdisinden DEGIL.
  const rows = db
    .prepare<[string, number], ArchivableRow>(
      `SELECT * FROM ${spec.table} WHERE ${spec.timestampColumn} IS NOT NULL AND ${spec.timestampColumn} < ? ORDER BY id LIMIT ?`
    )
    .all(cutoff, BATCH_LIMIT);

  if (rows.length === 0) return base;

  const olderThanCutoff = db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM ${spec.table} WHERE ${spec.timestampColumn} IS NOT NULL AND ${spec.timestampColumn} < ?`
    )
    .get(cutoff)!.c;

  const plain = toNdjson(rows);
  const contentSha = sha256(plain);
  const payload = encryptBuffer(gzipSync(plain));
  const fileName = `yakit-arsiv-${spec.table}-${timestampForFilename(now)}.ndjson.gz.enc`;

  writeArchiveFile(dir, fileName, payload);

  // DOGRULAMA: dosyayi diskten geri oku ve icindekinin gercekten arsivlemek istedigimiz
  // satirlar oldugunu kanitla. Bellekteki `payload` degiskenine bakmak hicbir sey ispatlamaz -
  // soru "dogru sey diske YAZILDI mi".
  const readBack = readFileSync(join(dir, fileName));
  const restored = parseNdjson(gunzipSync(decryptBuffer(readBack)));
  if (restored.length !== rows.length) {
    throw new Error(
      `Arsiv dogrulamasi basarisiz: ${fileName} icinde ${restored.length} satir var, ${rows.length} bekleniyordu. Hicbir satir silinmedi.`
    );
  }
  const expectedIds = rows.map((r) => r.id);
  const restoredIds = restored.map((r) => r.id);
  for (let i = 0; i < expectedIds.length; i++) {
    if (restoredIds[i] !== expectedIds[i]) {
      throw new Error(`Arsiv dogrulamasi basarisiz: ${fileName} icindeki satir kimlikleri eslesmiyor. Hicbir satir silinmedi.`);
    }
  }

  const ids = expectedIds;
  const timestamps = rows.map((r) => String(r[spec.timestampColumn]));
  const fileSha = sha256(readBack);

  // Kayit ve silme AYNI islemde: arsiv dosyasi kaydedilmeden satirlarin silinmesi
  // (ya da tersi) mumkun olmasin.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO archive_files
         (table_name, file_name, row_count, first_row_at, last_row_at, min_row_id, max_row_id, content_sha256, file_sha256, byte_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      spec.table,
      fileName,
      rows.length,
      timestamps.reduce((a, b) => (a < b ? a : b)),
      timestamps.reduce((a, b) => (a > b ? a : b)),
      ids[0]!,
      ids[ids.length - 1]!,
      contentSha,
      fileSha,
      readBack.byteLength
    );

    // Silme, esik ifadesiyle DEGIL, yukarida okunan KIMLIK LISTESIYLE yapilir. Esigi
    // yeniden calistirmak, dosya yazilirken araya girmis (ör. ajanin gec ilettigi eski
    // tarihli) bir satiri da silerdi - arsivde olmayan bir satiri.
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const chunk = ids.slice(i, i + DELETE_CHUNK);
      db.prepare(`DELETE FROM ${spec.table} WHERE id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
    }
  })();

  logger.info(
    { table: spec.table, fileName, rowCount: rows.length, cutoff },
    "Satirlar arsive tasindi ve canli tablodan dusuldu."
  );

  return {
    ...base,
    rowCount: rows.length,
    fileName,
    remaining: Math.max(0, olderThanCutoff - rows.length),
  };
}

/**
 * Tum arsivlenebilir tablolari tarar.
 *
 * ARCHIVE_DIR ayarlanmamissa HICBIR SEY yapmaz - ozellikle de silmez. Arsivlemenin
 * kapali olmasi "sil gitsin" demek degildir; arsivlenecek yer yoksa satirlar yerinde
 * kalir ve tablo buyumeye devam eder (bu, veri kaybetmekten iyidir).
 */
export function runArchive(now = new Date()): ArchiveRunResult {
  if (!env.ARCHIVE_DIR) return { enabled: false, tables: [], totalRows: 0 };

  // Dizin acilamiyorsa (yanlis yol, izin yok, mount dusmus) tarama SESSIZCE ve
  // ZARARSIZCA biter: hicbir satir silinmez. Bu hatanin disari firlamasi, arka plan
  // zamanlayicisinda yakalansa bile, arsivlemeyi bir yapilandirma hatasi yuzunden
  // gurultulu bir cokme haline getirirdi.
  try {
    mkdirSync(env.ARCHIVE_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err, dir: env.ARCHIVE_DIR }, "Arsiv dizini acilamadi - hicbir satir arsivlenmedi ya da silinmedi.");
    return { enabled: true, tables: [], totalRows: 0 };
  }

  const tables: ArchivedTableResult[] = [];

  for (const spec of ARCHIVABLE) {
    try {
      tables.push(archiveTable(spec, env.ARCHIVE_DIR, now));
    } catch (err) {
      // Bir tablonun arsivlenememesi digerlerini engellemez. Hata durumunda o tablodan
      // hicbir satir silinmemis olur (silme, dogrulamadan SONRA gelir).
      logger.error({ err, table: spec.table }, "Tablo arsivlenemedi - satirlar yerinde birakildi.");
      tables.push({ table: spec.table, label: spec.label, cutoff: "", rowCount: 0, fileName: null, remaining: 0 });
    }
  }

  return { enabled: true, tables, totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0) };
}

export interface ArchiveFileRow {
  id: number;
  table_name: string;
  file_name: string;
  row_count: number;
  first_row_at: string;
  last_row_at: string;
  min_row_id: number;
  max_row_id: number;
  content_sha256: string;
  file_sha256: string;
  byte_size: number;
  created_at: string;
}

export function listArchiveFiles(limit = 200): ArchiveFileRow[] {
  return db
    .prepare<[number], ArchiveFileRow>("SELECT * FROM archive_files ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit);
}

export interface ArchiveHealth {
  enabled: boolean;
  directory: string | null;
  /** Halen canli tabloda duran, esikten eski satir sayisi - "arsivleme yetisiyor mu". */
  pending: Array<{ table: string; label: string; cutoff: string; rows: number; liveRows: number }>;
  files: number;
  archivedRows: number;
}

/**
 * "Arsivleme ise yariyor mu" sorusunun cevabi. `pending` surekli buyuyorsa tarama
 * uretilen veriye yetismiyor demektir (BATCH_LIMIT ya da tarama araligi artirilmali).
 */
export function getArchiveHealth(now = new Date()): ArchiveHealth {
  const pending = ARCHIVABLE.map((spec) => {
    const cutoff = cutoffFor(resolveRetentionMonths(spec), now);
    const rows = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM ${spec.table} WHERE ${spec.timestampColumn} IS NOT NULL AND ${spec.timestampColumn} < ?`
      )
      .get(cutoff)!.c;
    const liveRows = db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${spec.table}`).get()!.c;
    return { table: spec.table, label: spec.label, cutoff, rows, liveRows };
  });

  const totals = db
    .prepare<[], { files: number; rows: number | null }>("SELECT COUNT(*) AS files, SUM(row_count) AS rows FROM archive_files")
    .get()!;

  return {
    enabled: !!env.ARCHIVE_DIR,
    directory: env.ARCHIVE_DIR ?? null,
    pending,
    files: totals.files,
    archivedRows: totals.rows ?? 0,
  };
}

/**
 * Bir arsiv dosyasini geri okur (bkz. scripts/readArchive.ts).
 *
 * Okunamayan bir arsiv, arsiv degildir. Bu fonksiyon hem operatorun elindeki tek geri
 * getirme yolu hem de dosyanin bozulmadigini dogrulama araci: kaydedilen ozetlerle
 * karsilastirir ve uyusmazsa hata firlatir.
 */
export function readArchiveFile(fileName: string): { rows: ArchivableRow[]; record: ArchiveFileRow } {
  if (!env.ARCHIVE_DIR) throw new Error("ARCHIVE_DIR tanimli degil.");
  const record = db.prepare<[string], ArchiveFileRow>("SELECT * FROM archive_files WHERE file_name = ?").get(fileName);
  if (!record) throw new Error(`Arsiv dizininde kayitli olmayan dosya: ${fileName}`);

  const raw = readFileSync(join(env.ARCHIVE_DIR, fileName));
  if (sha256(raw) !== record.file_sha256) {
    throw new Error(`Arsiv dosyasinin ozeti kayitla uyusmuyor (dosyaya dokunulmus olabilir): ${fileName}`);
  }
  const plain = gunzipSync(decryptBuffer(raw));
  if (sha256(plain) !== record.content_sha256) {
    throw new Error(`Arsiv iceriginin ozeti kayitla uyusmuyor: ${fileName}`);
  }
  return { rows: parseNdjson(plain), record };
}

/**
 * NEDEN transactions ARSIVLENMIYOR
 *
 * Gorev basligi "islem arsivleme" diyor; bilerek yapmadim, gerekcesi:
 *
 * 1. YASAL SURE. Islem kaydi ticari bir kayittir; TTK 82 ticari defter ve kayitlarin on
 *    yil saklanmasini ister. Yani dogru esik ~10 yil - bugun hicbir kurulum o yasta degil,
 *    yani bugun yazilacak kod on yil boyunca HIC CALISMAZ. Calismayan bir kod yolunu mali
 *    kayitlarin uzerine dogrultmak, test edilmemis makineyi kasaya baglamaktir.
 *
 * 2. BAGIMLI TABLOLAR. transactions'a alti tablo yabanci anahtarla bakiyor: refunds,
 *    invoices, fleet_movements, loyalty_movements, support_requests, fuel_stock_movements.
 *    Bir islemi tasimak, ona bagli iade/fatura satirlarini da AYNI grupta tasimayi
 *    gerektirir; aksi halde yetim mali kayit kalir. Bu, yukaridaki motorun ustune ayri bir
 *    bagimlilik grafigi cikarma isidir.
 *
 * 3. BUGUNKU BASKI BASKA YERDE. Buyume sirasi tank olcumu ve denetim kaydidir (saatlik
 *    uretim), islem degil (musteri basina bir satir). Once basincin oldugu yeri actik.
 *
 * transactions'i eklemek gerektiginde motor hazir: ARCHIVABLE'a bir satir eklemek yetmez,
 * bagimli satirlari da toplayan bir "grup" kavrami gerekir. Kapasite olcumu (gorev #154)
 * bunun ne zaman gerektigini SAYIYLA soyleyecek.
 *
 * alarms AYNI GEREKCEYLE (2) LISTEDE DEGIL: support_requests.alarm_id, ve iki tablo daha
 * (bkz. schema.sql) alarms(id)'e yabanci anahtarla bakiyor. Bir alarmi arsive tasimak,
 * o alarma bagli destek talebini/kaydi yetim birakir veya (grup kavrami olmadan) onu da
 * ayni anda tasimayi gerektirir - aynen transactions gibi. Bugunku baski (madde 3) da
 * henuz burada degil: alarms sweepAlarmEscalations() ile SIK okunuyor olsa da (bkz.
 * yukaridaki idx_alarms_severity_status indeksi) satir sayisi tank olcumu/denetim kaydi
 * kadar hizli buyumuyor. Gercek arsivleme istenirse once o FK'lerin arsivlenen bir alarma
 * ne olacagina (NULL'a mi cekilecek, yoksa o kayit da mi arsivlenecek) karar verilmeli.
 */
