import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFile, encryptFile } from "./backupCrypto.js";

describe("backupCrypto", () => {
  it("encryptFile + decryptFile round-trips arbitrary binary content exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-crypto-test-"));
    const srcPath = join(dir, "plain.bin");
    const encPath = join(dir, "cipher.bin");
    const outPath = join(dir, "decrypted.bin");

    const original = Buffer.from([0, 1, 2, 255, 254, 253, ...Buffer.from("SQLite format 3\0test-content")]);
    writeFileSync(srcPath, original);

    encryptFile(srcPath, encPath);
    const ciphertext = readFileSync(encPath);
    expect(ciphertext.equals(original)).toBe(false);
    expect(ciphertext.includes("SQLite format 3")).toBe(false);

    decryptFile(encPath, outPath);
    const decrypted = readFileSync(outPath);
    expect(decrypted.equals(original)).toBe(true);
  });

  it("decryptFile rejects a tampered ciphertext (authTag mismatch)", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-crypto-test-"));
    const srcPath = join(dir, "plain.bin");
    const encPath = join(dir, "cipher.bin");
    const outPath = join(dir, "decrypted.bin");

    writeFileSync(srcPath, Buffer.from("hassas veri"));
    encryptFile(srcPath, encPath);

    const tampered = readFileSync(encPath);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    writeFileSync(encPath, tampered);

    expect(() => decryptFile(encPath, outPath)).toThrow();
  });
});
