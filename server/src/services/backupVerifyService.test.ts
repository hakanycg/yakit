import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { encryptFile } from "../utils/backupCrypto.js";
import { createTestStation } from "../test/dbFixture.js";
import { runBackup } from "./backupService.js";
import { latestBackupPath, listBackups, verifyBackup, verifyLatestBackup } from "./backupVerifyService.js";

const originalBackupDir = env.BACKUP_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-verify-test-"));
  env.BACKUP_DIR = dir;
});

afterEach(() => {
  env.BACKUP_DIR = originalBackupDir;
});

/** Cozulmus gecici dosya diskte kalmamali: yedeklerin sifresiz durmamasi bu ozelligin varlik sebebiydi. */
function leftoverPlaintextFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".verify-"));
}

describe("gercek yedegin dogrulanmasi", () => {
  it("alinan yedegi cozer, acar ve gecerli bulur", async () => {
    createTestStation();
    const path = (await runBackup())!;

    const result = verifyBackup(path);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.integrityCheck).toBe("ok");
    expect(result.missingTables).toEqual([]);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("beklenen tablolarin satir sayilarini raporlar", async () => {
    createTestStation();
    const path = (await runBackup())!;

    const stations = verifyBackup(path).tables.find((t) => t.table === "stations")!;

    expect(stations.backupRows).toBeGreaterThan(0);
    expect(stations.liveRows).toBeGreaterThan(0);
  });

  it("satir sayilarinin BIREBIR esit olmasini beklemez", async () => {
    // Yedek anlik bir goruntudur; esitlik aramak surekli yanlis alarm uretirdi.
    createTestStation();
    const path = (await runBackup())!;
    createTestStation(); // yedekten SONRA yeni veri

    expect(verifyBackup(path).ok).toBe(true);
  });

  it("cozulmus gecici dosyayi diskte birakmaz", async () => {
    createTestStation();
    const path = (await runBackup())!;

    verifyBackup(path);

    expect(leftoverPlaintextFiles()).toEqual([]);
  });
});

describe("bozuk yedekler", () => {
  it("olmayan dosyayi reddeder", () => {
    const result = verifyBackup(join(dir, "yok.sqlite.enc"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bulunamadi");
  });

  it("bos dosyayi reddeder", () => {
    const path = join(dir, "yakit-backup-bos.sqlite.enc");
    writeFileSync(path, "");

    const result = verifyBackup(path);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("bos");
  });

  it("sifresi cozulemeyen dosyayi reddeder", async () => {
    // En sinsi senaryo: anahtar degismisse dosyalar diskte durur, boyutlari dogrudur,
    // ama hicbiri acilamaz.
    createTestStation();
    const path = (await runBackup())!;
    const data = readFileSync(path);
    data[40] = data[40]! ^ 0xff; // sifreli govdeyi boz
    writeFileSync(path, data);

    const result = verifyBackup(path);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sifresi cozulemedi");
  });

  it("SQLite olmayan bir icerigi reddeder", () => {
    // Sifreleme basarili ama icerik veritabani degil: bu da gecmemeli.
    const plain = join(dir, "duz.txt");
    const path = join(dir, "yakit-backup-sahte.sqlite.enc");
    writeFileSync(plain, "bu bir veritabani degil");
    encryptFile(plain, path);

    const result = verifyBackup(path);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SQLite|butunluk/);
  });

  it("tablolari eksik bir veritabanini reddeder", () => {
    // Elde bir SQLite dosyasi vardir ama kullanilabilir bir yedek yoktur.
    const plain = join(dir, "eksik.sqlite");
    const path = join(dir, "yakit-backup-eksik.sqlite.enc");
    const tmp = new Database(plain);
    tmp.exec("CREATE TABLE stations (id INTEGER PRIMARY KEY)");
    tmp.close();
    encryptFile(plain, path);

    const result = verifyBackup(path);

    expect(result.ok).toBe(false);
    expect(result.missingTables).toContain("users");
    expect(result.error).toContain("eksik");
  });

  it("bozuk yedekte de gecici dosyayi temizler", async () => {
    createTestStation();
    const path = (await runBackup())!;
    const data = readFileSync(path);
    data[40] = data[40]! ^ 0xff;
    writeFileSync(path, data);

    verifyBackup(path);

    expect(leftoverPlaintextFiles()).toEqual([]);
  });
});

describe("en son yedegin otomatik dogrulanmasi", () => {
  it("BACKUP_DIR yoksa hicbir sey yapmaz", () => {
    env.BACKUP_DIR = undefined;
    expect(verifyLatestBackup()).toBeNull();
  });

  it("hic yedek yoksa null doner", () => {
    expect(latestBackupPath()).toBeNull();
    expect(verifyLatestBackup()).toBeNull();
  });

  it("en yeni yedegi secer", async () => {
    createTestStation();
    await runBackup();
    await runBackup();

    const all = listBackups();
    expect(all.length).toBe(2);
    expect(latestBackupPath()).toBe(all[0]);
  });

  it("basarisizlikta kritik alarm uretir", async () => {
    createTestStation();
    const path = (await runBackup())!;
    const data = readFileSync(path);
    data[40] = data[40]! ^ 0xff;
    writeFileSync(path, data);

    const before = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM alarms WHERE type = 'backup_verification_failed'")
      .get()!.c;
    const result = verifyLatestBackup()!;

    expect(result.ok).toBe(false);
    expect(
      db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM alarms WHERE type = 'backup_verification_failed'").get()!.c
    ).toBe(before + 1);
  });

  it("alarm zaten aciksa ikincisini acmaz", async () => {
    // Her yedek turunda yeni alarm acmak alarm merkezini doldurur ve yukseltme
    // mantigini da bozardi.
    createTestStation();
    const path = (await runBackup())!;
    const data = readFileSync(path);
    data[40] = data[40]! ^ 0xff;
    writeFileSync(path, data);

    verifyLatestBackup();
    const after = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM alarms WHERE type = 'backup_verification_failed' AND status != 'resolved'")
      .get()!.c;
    verifyLatestBackup();

    expect(
      db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM alarms WHERE type = 'backup_verification_failed' AND status != 'resolved'")
        .get()!.c
    ).toBe(after);
  });

  it("yedek duzelince alarm kendiliginden cozulur", async () => {
    // Operatorun elle temizlemesi gereken bir kalinti birakmamak icin.
    createTestStation();
    const bad = (await runBackup())!;
    const data = readFileSync(bad);
    data[40] = data[40]! ^ 0xff;
    writeFileSync(bad, data);
    verifyLatestBackup();

    // Saglam yeni bir yedek al: artik en yeni olan odur.
    await runBackup();
    const result = verifyLatestBackup()!;

    expect(result.ok).toBe(true);
    expect(
      db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM alarms WHERE type = 'backup_verification_failed' AND status != 'resolved'")
        .get()!.c
    ).toBe(0);
  });
});
