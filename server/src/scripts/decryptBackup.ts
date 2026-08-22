import { decryptFile } from "../utils/backupCrypto.js";

/**
 * Felaket kurtarma/geri yukleme araci: backupService.ts'in urettigi sifreli bir yedek
 * dosyasini (.sqlite.enc) tekrar acilabilir bir .sqlite dosyasina cozer. Kullanim:
 *   npm run decrypt-backup -- <sifreli-dosya> <cikti-dosyasi>
 * Ayni SESSION_SECRET/SETTINGS_ENCRYPTION_KEY'in (yedegin alindigi sunucudakiyle AYNI
 * olmasi sart) o an calisan ortamda (.env) tanimli olmasi gerekir - aksi halde
 * decryptFile "Unsupported state or unable to authenticate data" hatasiyla basarisiz olur.
 */
const [srcPath, destPath] = process.argv.slice(2);

if (!srcPath || !destPath) {
  console.error("Kullanim: npm run decrypt-backup -- <sifreli-dosya.sqlite.enc> <cikti-dosyasi.sqlite>");
  process.exit(1);
}

decryptFile(srcPath, destPath);
console.log(`Yedek cozuldu: ${destPath}`);
