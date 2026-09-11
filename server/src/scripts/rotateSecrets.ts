import { rotateEncryptedSecrets } from "../utils/secretsCrypto.js";

/**
 * Sir anahtari rotasyonu (bkz. utils/secretsCrypto.ts). Kullanim:
 *   1) SETTINGS_ENCRYPTION_KEY_V2 ortam degiskenine YENI bir deger yaz
 *      (`openssl rand -hex 32`) ve sunucuyu yeniden baslat - bu andan itibaren
 *      YENI sirlar zaten yeni anahtarla yazilir.
 *   2) npm run rotate-secrets  -- ESKI (v1) anahtarla sifrelenmis mevcut sirlari
 *      da yeni anahtara tasir.
 */
const result = rotateEncryptedSecrets();
console.log(`Rotasyon tamamlandi: ${result.rotated} sir tasindi, ${result.failed} sir cozulemedi.`);
if (result.failed > 0) process.exit(1);
