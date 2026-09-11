import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { env } from "../config.js";
import { createTestStation } from "../test/dbFixture.js";
import { decryptSecret, encryptedVersion, encryptLegacyPlaintextSecrets, encryptSecret, isEncrypted, resetKeyCacheForTest, rotateEncryptedSecrets } from "./secretsCrypto.js";

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

describe("secretsCrypto - anahtar surumleme/rotasyon", () => {
  it("yeni sirlar guncel surumle (v2) sifrelenir", () => {
    const cipher = encryptSecret("deger");
    expect(cipher.startsWith("enc:v2:")).toBe(true);
    expect(encryptedVersion(cipher)).toBe(2);
  });

  it("duz metin icin encryptedVersion null doner", () => {
    expect(encryptedVersion("duz-metin")).toBeNull();
    expect(encryptedVersion(null)).toBeNull();
  });

  it("eski surumle (v1) sifrelenmis bir deger, YENI SETTINGS_ENCRYPTION_KEY_V2 tanimliyken bile hala cozulebilir", async () => {
    const { encryptSecretAtVersionForTest } = await import("./secretsCrypto.js");
    const v1Cipher = encryptSecretAtVersionForTest("eski-sir", 1);
    expect(encryptedVersion(v1Cipher)).toBe(1);

    const previous = env.SETTINGS_ENCRYPTION_KEY_V2;
    env.SETTINGS_ENCRYPTION_KEY_V2 = "test-rotasyon-anahtari-cok-uzun-ve-rastgele";
    resetKeyCacheForTest();
    try {
      // v2 anahtari degismis olsa da v1 kendi anahtariyla (SETTINGS_ENCRYPTION_KEY/SESSION_SECRET)
      // hala cozulebilir olmali - versiyonlamanin butun amaci bu.
      expect(decryptSecret(v1Cipher)).toBe("eski-sir");
    } finally {
      env.SETTINGS_ENCRYPTION_KEY_V2 = previous;
      resetKeyCacheForTest();
    }
  });
});

describe("secretsCrypto - rotateEncryptedSecrets", () => {
  const previousV2 = env.SETTINGS_ENCRYPTION_KEY_V2;

  afterEach(() => {
    env.SETTINGS_ENCRYPTION_KEY_V2 = previousV2;
    resetKeyCacheForTest();
  });

  it("eski surumle sifrelenmis sirlari guncel anahtarla yeniden sifreler", async () => {
    const { encryptSecretAtVersionForTest } = await import("./secretsCrypto.js");
    const station = createTestStation();
    const v1Cipher = encryptSecretAtVersionForTest("eski-api-anahtari", 1);
    db.prepare("INSERT INTO settings (station_id, key, value) VALUES (?, 'iyzico_secret_key', ?)").run(station.id, v1Cipher);

    // Rotasyon senaryosu: yeni bir V2 anahtari tanimlanir.
    env.SETTINGS_ENCRYPTION_KEY_V2 = "yepyeni-rotasyon-anahtari-9999999999";
    resetKeyCacheForTest();

    const result = rotateEncryptedSecrets();
    expect(result.rotated).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const row = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "iyzico_secret_key")!;
    expect(encryptedVersion(row.value)).toBe(2);
    expect(decryptSecret(row.value)).toBe("eski-api-anahtari");
  });

  it("zaten guncel surumdeki bir sirri tekrar tasimaz (idempotentlik)", () => {
    const station = createTestStation();
    const currentCipher = encryptSecret("zaten-guncel");
    db.prepare("INSERT INTO settings (station_id, key, value) VALUES (?, 'invoice_password', ?)").run(station.id, currentCipher);

    rotateEncryptedSecrets();
    const row = db
      .prepare<[number, string], { value: string }>("SELECT value FROM settings WHERE station_id = ? AND key = ?")
      .get(station.id, "invoice_password")!;
    expect(row.value).toBe(currentCipher);
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
