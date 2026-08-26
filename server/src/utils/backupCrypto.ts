import { readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../config.js";

/**
 * Veritabani yedekleri (bkz. backupService.ts) diskten baska bir yere - ör. bir veri
 * merkeziyle anlasilan, ONLARIN gozetimindeki bir bulut yedekleme hizmetine - tasinacak.
 * O depolamanin kim tarafindan yonetildigine guvenilse bile, savunma-derinligi geregi
 * (defense-in-depth) sunucudan CIKMADAN once sifrelenmesi gerekir: boylece o depolama
 * ele gecirilse/yanlis yapilandirilsa/incelemeye acilsa bile, iceriği BIZIM anahtarimiz
 * olmadan anlamsizdir.
 *
 * Anahtar: secretsCrypto.ts ile AYNI prensip - ayri bir zorunlu env degiskeni EKLEMEMEK
 * icin, zaten opsiyonel olan SETTINGS_ENCRYPTION_KEY (yoksa zorunlu SESSION_SECRET'tan)
 * turetilir. Farkli bir salt kullanilir ki iki anahtar birbirinden bagimsiz olsun.
 */

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = env.SETTINGS_ENCRYPTION_KEY || env.SESSION_SECRET;
  cachedKey = scryptSync(material, "yakit-backup-encryption-v1", 32);
  return cachedKey;
}

/**
 * Format: [iv (12 byte)][authTag (16 byte)][ciphertext].
 *
 * Bellek uzerinde calisan bu ikili, dosya yardimcilarinin altinda durur ve ayrica arsiv
 * dosyalari (bkz. services/archiveService.ts) tarafindan dogrudan kullanilir - arsiv,
 * icerigi zaten bellekte uretir, once duz-metin bir gecici dosyaya yazmasi hem gereksiz
 * hem de kisisel veriyi diske sifresiz dusurmek olurdu.
 */
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** encryptBuffer'in tersi. Kurcalanmis/yanlis anahtarla acilan veri, GCM auth tag'i
 * yuzunden sessizce bozuk donmez - dogrudan hata firlatir. */
export function decryptBuffer(data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptFile(srcPath: string, destPath: string): void {
  writeFileSync(destPath, encryptBuffer(readFileSync(srcPath)));
}

/** encryptFile ile sifrelenmis bir yedegi cozer - felaket kurtarma/restore sirasinda kullanilir (bkz. scripts/decryptBackup.ts). */
export function decryptFile(srcPath: string, destPath: string): void {
  writeFileSync(destPath, decryptBuffer(readFileSync(srcPath)));
}
