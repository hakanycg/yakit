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
 * Anahtar VE ROTASYON: ayri bir SETTINGS_ENCRYPTION_KEY ayarlanmamissa (opsiyonel -
 * mevcut dagitim ortamlarinda yeni bir zorunlu env degiskeni EKLEMEMEK icin bilerek
 * boyle tasarlandi, bkz. Railway crash-loop dersinden sonraki "asla zorunlu yeni env
 * degiskeni ekleme" prensibi), zaten zorunlu olan SESSION_SECRET'tan turetilir -
 * boylece sifreleme hicbir ek kurulum adimi gerektirmeden HER ZAMAN aktif olur.
 *
 * Her sifreli deger, KENDI anahtar surumunu tasir (`enc:v1:...`, `enc:v2:...`) -
 * decryptSecret bu onekten hangi anahtarla cozecegini bilir. Bu, TEK bir sabit
 * anahtarla sonsuza kadar sifrelemek yerine gercek bir rotasyona izin verir: bir
 * anahtarin ele gecirilmis OLABILECEGINDEN suphelenilirse, SETTINGS_ENCRYPTION_KEY_V2
 * ortam degiskenine YENI bir deger yazilir, sunucu yeniden baslatilir (yeni sirlar artik
 * v2 ile sifrelenir) ve rotateEncryptedSecrets() calistirilarak ESKI v1 degerleri de
 * yeni anahtarla yeniden sifrelenir - hicbir deger cozulemez hale gelmeden.
 */

const CURRENT_VERSION = 2;

function keyMaterialForVersion(version: number): string {
  if (version <= 1) return env.SETTINGS_ENCRYPTION_KEY || env.SESSION_SECRET;
  // v2 (ve rotasyon tanimlanmadigi surece sonraki tum surumler icin varsayilan):
  // ozel bir SETTINGS_ENCRYPTION_KEY_V2 verilmemisse ayni malzemeye duser, ama
  // ASAGIDAKI farkli tuz (salt) nedeniyle yine de v1'den FARKLI bir anahtar turetilir.
  return env.SETTINGS_ENCRYPTION_KEY_V2 || env.SETTINGS_ENCRYPTION_KEY || env.SESSION_SECRET;
}

const keyCache = new Map<number, Buffer>();

function getKey(version: number): Buffer {
  const cached = keyCache.get(version);
  if (cached) return cached;
  const key = scryptSync(keyMaterialForVersion(version), `yakit-settings-encryption-v${version}`, 32);
  keyCache.set(version, key);
  return key;
}

/**
 * Yalnizca testler icin: scrypt turetmesi pahali oldugu icin anahtarlar cache'lenir -
 * normal calismada bu sorun degil (env degiskenleri surec boyunca degismez, bkz.
 * dosya basindaki "sunucu yeniden baslatilir" akisi), ama bir testin env.SETTINGS_ENCRYPTION_KEY_V2'yi
 * degistirip HEMEN etkisini gormesi icin cache'in temizlenmesi gerekir.
 */
export function resetKeyCacheForTest(): void {
  keyCache.clear();
}

const PREFIX_RE = /^enc:v(\d+):/;

function encryptSecretAtVersion(plainText: string, version: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(version), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v${version}:${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Yeni sirlar HER ZAMAN guncel surumle sifrelenir - rotasyon sonrasi ayrica kod degisikligi gerekmez. */
export function encryptSecret(plainText: string): string {
  return encryptSecretAtVersion(plainText, CURRENT_VERSION);
}

/**
 * Yalnizca testler icin: BELIRLI bir eski surumle sifreler - rotateEncryptedSecrets'in
 * "eski anahtarli bir sir bulunca guncel anahtara tasir" davranisini simule etmek icin
 * gerekli (encryptSecret her zaman guncel surumu uretir, kasitli olarak eskisini uretemez).
 */
export function encryptSecretAtVersionForTest(plainText: string, version: number): string {
  return encryptSecretAtVersion(plainText, version);
}

/**
 * "enc:vN:" onekiyle baslamayan degerler, sifreleme bu ozellik eklenmeden ONCE
 * yazilmis eski duz-metin kayitlardir - geriye donuk uyumluluk icin oldugu gibi
 * dondurulur (bkz. encryptLegacyPlaintextSecrets, bunlari ilk sunucu baslangicinda
 * tek seferlik sifreler). Bozuk/çözülemeyen bir deger sunucuyu coktürmez; null
 * dondurup loglar - cagiran taraf bunu "yapilandirilmamis" gibi ele alir.
 */
export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  const match = stored.match(PREFIX_RE);
  if (!match) return stored;

  try {
    const version = Number(match[1]);
    const rest = stored.slice(match[0].length);
    const [ivB64, authTagB64, cipherB64] = rest.split(":");
    if (!ivB64 || !authTagB64 || !cipherB64) throw new Error("Gecersiz sifreli deger formati.");
    const decipher = createDecipheriv("aes-256-gcm", getKey(version), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch (err) {
    logger.error({ err }, "Sifreli ayar cozulemedi - yapilandirilmamis olarak ele alinacak.");
    return null;
  }
}

export function isEncrypted(value: string | null): boolean {
  return !!value && PREFIX_RE.test(value);
}

/** Bir degerin hangi anahtar surumuyle sifrelendigi - null: sifreli degil (duz metin ya da bos). */
export function encryptedVersion(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(PREFIX_RE);
  return match ? Number(match[1]) : null;
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

/**
 * Anahtar rotasyonu: CURRENT_VERSION'dan ESKI bir surumle sifrelenmis tum sirlari
 * cozup GUNCEL anahtarla yeniden sifreler. Operasyonel akis: SETTINGS_ENCRYPTION_KEY_V2
 * ortam degiskenine yeni bir deger yazilir -> sunucu yeniden baslatilir (bu noktadan
 * sonra YENI sirlar zaten v2 ile yazilir, ama ESKI v1 degerler hala v1 anahtariyla
 * sifrelidir) -> bu fonksiyon (ör. bir bakim script'i/admin ucundan) calistirilarak
 * eskiler de guncel anahtara tasinir. Idempotenttir - zaten guncel surumdeki satirlari
 * atlar. Cozulemeyen (bozuk/eski anahtar artik gecerli degil) bir satir ATLANIR ve
 * loglanir - rotasyonun geri kalanini durdurmaz, ama sonucta rapor edilir.
 */
export function rotateEncryptedSecrets(): { rotated: number; failed: number } {
  const placeholders = SENSITIVE_SETTING_KEYS.map(() => "?").join(",");
  const rows = db
    .prepare<string[], { station_id: number; key: string; value: string }>(
      `SELECT station_id, key, value FROM settings WHERE key IN (${placeholders})`
    )
    .all(...SENSITIVE_SETTING_KEYS);

  const update = db.prepare("UPDATE settings SET value = ? WHERE station_id = ? AND key = ?");
  let rotated = 0;
  let failed = 0;
  for (const row of rows) {
    const version = encryptedVersion(row.value);
    if (version === null || version >= CURRENT_VERSION) continue;
    const plain = decryptSecret(row.value);
    if (plain === null) {
      failed += 1;
      continue;
    }
    update.run(encryptSecret(plain), row.station_id, row.key);
    rotated += 1;
  }
  logger.info({ rotated, failed }, "Sir anahtari rotasyonu tamamlandi.");
  return { rotated, failed };
}
