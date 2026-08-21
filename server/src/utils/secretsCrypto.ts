import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../config.js";
import { logger } from "./logger.js";
import { db } from "../db/index.js";

/**
 * iyzico/Uyumsoft gibi ucuncu taraf saglayicilarin API anahtari/sifresi, bu sistemde
 * ayni genel amacli "settings" tablosunda tutuluyordu - SQLite dosyasi ele gecirilirse
 * (calinan bir yedek, yanlis yapilandirilmis depolama vb.) canli odeme/e-belge
 * kimlik bilgileri dogrudan acikta kalirdi. Bu modul bu tur sirlari AES-256-GCM ile
 * durumda (at-rest) sifreler.
 *
 * Anahtar: ayri bir SETTINGS_ENCRYPTION_KEY ayarlanmamissa (opsiyonel - mevcut
 * dagitim ortamlarinda yeni bir zorunlu env degiskeni EKLEMEMEK icin bilerek boyle
 * tasarlandi, bkz. Railway crash-loop dersinden sonraki "asla zorunlu yeni env
 * degiskeni ekleme" prensibi), zaten zorunlu olan SESSION_SECRET'tan turetilir -
 * boylece sifreleme hicbir ek kurulum adimi gerektirmeden HER ZAMAN aktif olur.
 */

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = env.SETTINGS_ENCRYPTION_KEY || env.SESSION_SECRET;
  cachedKey = scryptSync(material, "yakit-settings-encryption-v1", 32);
  return cachedKey;
}

const PREFIX = "enc:v1:";

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * "enc:v1:" onekiyle baslamayan degerler, sifreleme bu ozellik eklenmeden ONCE
 * yazilmis eski duz-metin kayitlardir - geriye donuk uyumluluk icin oldugu gibi
 * dondurulur (bkz. encryptLegacyPlaintextSecrets, bunlari ilk sunucu baslangicinda
 * tek seferlik sifreler). Bozuk/çözülemeyen bir deger sunucuyu coktürmez; null
 * dondurup loglar - cagiran taraf bunu "yapilandirilmamis" gibi ele alir.
 */
export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;

  try {
    const [ivB64, authTagB64, cipherB64] = stored.slice(PREFIX.length).split(":");
    if (!ivB64 || !authTagB64 || !cipherB64) throw new Error("Gecersiz sifreli deger formati.");
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch (err) {
    logger.error({ err }, "Sifreli ayar cozulemedi - yapilandirilmamis olarak ele alinacak.");
    return null;
  }
}

export function isEncrypted(value: string | null): boolean {
  return !!value && value.startsWith(PREFIX);
}

const SENSITIVE_SETTING_KEYS = ["iyzico_api_key", "iyzico_secret_key", "invoice_password"];

/**
 * Bu ozellik eklenmeden once yazilmis duz-metin iyzico/Uyumsoft sirlarini, sunucu
 * baslarken bir kez tarayip yerinde sifreler (tum istasyonlar icin). Idempotenttir -
 * zaten "enc:v1:" onekiyle sifrelenmis satirlari atlar - bu yuzden her baslangicta
 * güvenle tekrar cagrilabilir.
 */
export function encryptLegacyPlaintextSecrets(): void {
  const placeholders = SENSITIVE_SETTING_KEYS.map(() => "?").join(",");
  const rows = db
    .prepare<string[], { station_id: number; key: string; value: string }>(
      `SELECT station_id, key, value FROM settings WHERE key IN (${placeholders})`
    )
    .all(...SENSITIVE_SETTING_KEYS);

  const update = db.prepare("UPDATE settings SET value = ? WHERE station_id = ? AND key = ?");
  let migrated = 0;
  for (const row of rows) {
    if (isEncrypted(row.value)) continue;
    update.run(encryptSecret(row.value), row.station_id, row.key);
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info({ migrated }, "Eski duz-metin iyzico/Uyumsoft sirlari sifrelendi.");
  }
}
