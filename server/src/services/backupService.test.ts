import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../config.js";
import { decryptFile } from "../utils/backupCrypto.js";
import { runBackup } from "./backupService.js";

const SQLITE_MAGIC = "SQLite format 3\0";

describe("runBackup", () => {
  const originalBackupDir = env.BACKUP_DIR;

  afterEach(() => {
    env.BACKUP_DIR = originalBackupDir;
  });

  it("does nothing when BACKUP_DIR is not configured", async () => {
    env.BACKUP_DIR = undefined;
    const result = await runBackup();
    expect(result).toBeNull();
  });

  it("writes an ENCRYPTED backup (not a raw SQLite file) and leaves no plaintext temp file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-service-test-"));
    env.BACKUP_DIR = dir;

    const destPath = await runBackup();
    expect(destPath).not.toBeNull();
    expect(destPath).toMatch(/yakit-backup-.*\.sqlite\.enc$/);

    const filesInDir = readdirSync(dir);
    // Sifreleme oncesi kullanilan gecici duz-metin dosya (.tmp-*.sqlite) silinmis olmali.
    expect(filesInDir.some((f) => f.startsWith(".tmp-"))).toBe(false);

    const ciphertext = readFileSync(destPath!);
    expect(ciphertext.toString("latin1", 0, SQLITE_MAGIC.length)).not.toBe(SQLITE_MAGIC);

    const decryptedPath = join(dir, "decrypted-check.sqlite");
    decryptFile(destPath!, decryptedPath);
    const plainBackup = readFileSync(decryptedPath);
    expect(plainBackup.toString("latin1", 0, SQLITE_MAGIC.length)).toBe(SQLITE_MAGIC);
  });
});
