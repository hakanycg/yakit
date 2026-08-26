import { db } from "../db/index.js";
import type { SystemErrorRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { createAlarm } from "./alarmService.js";

/**
 * Sunucu hatalarinin izlenmesi ve esik asilinca alarma cevrilmesi.
 *
 * Sistemde 20'den fazla alarm tipi vardi - yakit sapmasi, kalibrasyon toleransi, gec
 * gelen odeme, dusuk bakiye, destek talebi - ve hepsi kritik alarma donup e-posta/SMS
 * gonderiyordu. "Sunucu hata veriyor" icin ise hicbiri yoktu: errorHandler,
 * uncaughtException ve unhandledRejection yalnizca logluyordu.
 *
 * Yani bir filo hesabinin bakiyesi 100 TL azaldiginda nobetci personele SMS gidiyor;
 * API tum kiosk'lara 500 dondurdugunde HICBIR SEY gitmiyordu. Personelsiz istasyonda
 * musteri sikayet etmez - arabasina binip gider.
 */

/** Bu pencerede bu kadar hata birikirse alarm uretilir. */
const WINDOW_MS = 10 * 60 * 1000;
const ERROR_THRESHOLD = 5;

/**
 * Alarm, hata akisi bu sure boyunca tamamen durursa cozulur.
 *
 * Pencereden (10 dk) UZUN tutuluyor: esigin hemen altina inen dalgali bir hata akisi
 * alarmi acip kapatip acip kapatirdi ve her aciliste yeni bir bildirim giderdi.
 */
const QUIET_MS = 30 * 60 * 1000;

const ALARM_TYPE = "system_error_rate";

/** Log satirini sisirmemek icin: yigin izi zaten logger'a ayrica gidiyor. */
const MAX_MESSAGE_LENGTH = 500;

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.slice(0, MAX_MESSAGE_LENGTH);
}

function countSince(sinceIso: string): number {
  const row = db
    .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM system_errors WHERE created_at >= ?")
    .get(sinceIso);
  return row?.c ?? 0;
}

/**
 * Alarmin yazilacagi istasyon.
 *
 * Sunucu hatasi TUM sisteme aittir, tek bir istasyona degil; ama alarm merkezi istasyon
 * bazlidir ve bir yere yazilmasi gerekir. Yedek dogrulamasiyla ayni cozum: en dusuk
 * id'li aktif istasyon secilir ve mesajda bunun sistem geneli bir uyari oldugu acikca
 * yazar (bkz. backupVerifyService.verifyLatestBackup).
 */
function platformStationId(): number | null {
  const row = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1 ORDER BY id LIMIT 1").get();
  return row?.id ?? null;
}

function openAlarmId(stationId: number): number | null {
  const row = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1"
    )
    .get(stationId, ALARM_TYPE);
  return row?.id ?? null;
}

/**
 * Bir sunucu hatasini kaydeder ve esik asildiysa alarm uretir.
 *
 * BU FONKSIYON ASLA HATA FIRLATMAZ. Cagrildigi yer zaten hata isleme yolu: buradan
 * cikan bir istisna errorHandler'a geri doner, o yine buraya gelir ve sunucu sonsuz
 * donguye girer. Veritabani yazilamiyorsa ya da alarm uretilemiyorsa yapilacak dogru
 * sey sessizce loglayip gecmektir - hata izlemenin kendisi kesintiye sebep olamaz.
 */
export function recordSystemError(input: {
  kind: SystemErrorRow["kind"];
  path?: string | null;
  error: unknown;
}): void {
  try {
    db.prepare("INSERT INTO system_errors (kind, path, message) VALUES (?, ?, ?)").run(
      input.kind,
      input.path ?? null,
      messageOf(input.error)
    );
    evaluateErrorRate();
  } catch (err) {
    logger.error({ err }, "Sunucu hatasi kaydedilemedi - hata izleme devre disi kalmis olabilir.");
  }
}

/**
 * Pencereye bakip alarmi acar ya da cozer.
 *
 * Ayri bir fonksiyon: hata anindan bagimsiz olarak periyodik de cagrilir. Hatalar
 * kesildiginde alarmi cozecek bir sey olmali - aksi halde alarm, yeni bir hata
 * gelmedigi surece sonsuza kadar acik kalirdi.
 */
export function evaluateErrorRate(now = Date.now()): void {
  const stationId = platformStationId();
  if (stationId === null) return; // Hic istasyon yoksa alarm yazacak yer de yok.

  const existing = openAlarmId(stationId);
  const recent = countSince(new Date(now - WINDOW_MS).toISOString());

  if (recent >= ERROR_THRESHOLD && existing === null) {
    const sample = db
      .prepare<[string], { path: string | null; message: string }>(
        "SELECT path, message FROM system_errors WHERE created_at >= ? ORDER BY id DESC LIMIT 1"
      )
      .get(new Date(now - WINDOW_MS).toISOString());

    createAlarm({
      stationId,
      type: ALARM_TYPE,
      severity: "critical",
      message:
        `SISTEM GENELI: son ${Math.round(WINDOW_MS / 60000)} dakikada ${recent} islenmeyen sunucu hatasi olustu. ` +
        (sample ? `Son hata${sample.path ? ` (${sample.path})` : ""}: ${sample.message}. ` : "") +
        `Musteriler islem yapamiyor olabilir; sunucu loglarini kontrol edin.`,
    });
    return;
  }

  // Hata akisi tamamen durduysa alarmi coz: giderilen bir sorunun alarminin elle
  // temizlenmesi gereken bir kalinti birakmamasi (ayni desen: dusuk stok, yedek
  // dogrulama).
  if (existing !== null && countSince(new Date(now - QUIET_MS).toISOString()) === 0) {
    db.prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?").run(
      new Date(now).toISOString(),
      existing
    );
    logger.info("Sunucu hata akisi durdu; sistem hatasi alarmi cozuldu.");
  }
}

export interface SystemErrorHealth {
  /** Son pencerede biriken hata sayisi. */
  recentCount: number;
  windowMinutes: number;
  threshold: number;
  lastErrorAt: string | null;
}

/** Saglik ucunun (ve panelin) okudugu ozet. */
export function getSystemErrorHealth(now = Date.now()): SystemErrorHealth {
  const since = new Date(now - WINDOW_MS).toISOString();
  const last = db
    .prepare<[], { created_at: string }>("SELECT created_at FROM system_errors ORDER BY id DESC LIMIT 1")
    .get();
  return {
    recentCount: countSince(since),
    windowMinutes: Math.round(WINDOW_MS / 60000),
    threshold: ERROR_THRESHOLD,
    lastErrorAt: last?.created_at ?? null,
  };
}

/** Son hatalar - teshis icin panelde gosterilir. */
export function listSystemErrors(limit = 50): SystemErrorRow[] {
  return db
    .prepare<[number], SystemErrorRow>("SELECT * FROM system_errors ORDER BY id DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 200));
}

/**
 * Eski hata kayitlarini budar. Bu tablo teshis icindir, arsiv degil: 30 gunden eski
 * bir hata kaydinin kimseye faydasi yok ama tablo sinirsiz buyumeye devam ederdi.
 */
export function pruneSystemErrors(olderThanMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()): number {
  const result = db
    .prepare("DELETE FROM system_errors WHERE created_at < ?")
    .run(new Date(now - olderThanMs).toISOString());
  return result.changes;
}
