import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { createTestStation } from "../test/dbFixture.js";
import { decryptSecret, encryptLegacyPlaintextSecrets, encryptSecret, isEncrypted } from "./secretsCrypto.js";

describe("secretsCrypto", () => {
  it("encrypts and decrypts a secret back to the original value", () => {
    const cipher = encryptSecret("iyzico-secret-abc123");
    expect(cipher).not.toBe("iyzico-secret-abc123");
    expect(isEncrypted(cipher)).toBe(true);
    expect(decryptSecret(cipher)).toBe("iyzico-secret-abc123");
  });

  it("produces a different ciphertext each time (random IV) even for the same input", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("passes through legacy plaintext values unchanged (backward compatibility)", () => {
    expect(decryptSecret("plain-old-value")).toBe("plain-old-value");
    expect(isEncrypted("plain-old-value")).toBe(false);
  });

  it("returns null for a corrupted/tampered ciphertext instead of throwing", () => {
    const cipher = encryptSecret("secret");
    const tampered = cipher.slice(0, -4) + "abcd";
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(decryptSecret(null)).toBeNull();
  });
});

describe("secretsCrypto - encryptLegacyPlaintextSecrets migration", () => {
  it("encrypts pre-existing plaintext iyzico/invoice settings in place, idempotently", () => {
    const station = createTestStation();
    db.prepare("INSERT INTO settings (station_id, key, value) VALUES (?, 'iyzico_secret_key', 'plain-secret')").run(station.id);
    db.prepare("INSERT INTO settings (station_id, key, value) VALUES (?, 'invoice_password', 'plain-password')").run(station.id);
    db.prepare("INSERT INTO settings (station_id, key, value) VALUES (?, 'invoice_username', 'not-a-secret')").run(station.id);

    encryptLegacyPlaintextSecrets();

    const secretRow = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "iyzico_secret_key")!;
    expect(isEncrypted(secretRow.value)).toBe(true);
    expect(decryptSecret(secretRow.value)).toBe("plain-secret");

    const passwordRow = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "invoice_password")!;
    expect(decryptSecret(passwordRow.value)).toBe("plain-password");

    // Sir olmayan alanlar (kullanici adi vb.) sifrelenmemeli.
    const usernameRow = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "invoice_username")!;
    expect(usernameRow.value).toBe("not-a-secret");

    // Ikinci calistirma zaten sifreli satiri bozmamali (idempotentlik).
    const before = secretRow.value;
    encryptLegacyPlaintextSecrets();
    const after = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "iyzico_secret_key")!;
    expect(after.value).toBe(before);
  });
});
