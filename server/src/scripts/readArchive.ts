import { writeFileSync } from "node:fs";
import { listArchiveFiles, readArchiveFile } from "../services/archiveService.js";

/**
 * Arsiv okuma araci (bkz. services/archiveService.ts).
 *
 * Okunamayan bir arsiv, arsiv degildir. Bu betik, arsivlenmis satirlarin tek geri getirme
 * yolu ve ayni zamanda "dosya bozulmus mu" denetimi: kaydedilen SHA-256 ozetleriyle
 * karsilastirir, uyusmazsa yazdirmak yerine HATA verir.
 *
 * Kullanim:
 *   npm run read-archive                          -> arsiv dosyalarini listeler
 *   npm run read-archive -- <dosya-adi>           -> icerigi NDJSON olarak stdout'a yazar
 *   npm run read-archive -- <dosya-adi> <cikti>   -> bir dosyaya yazar
 *
 * Ayni SESSION_SECRET/SETTINGS_ENCRYPTION_KEY'in (arsivin uretildigi sunucudakiyle AYNI)
 * ortamda tanimli olmasi gerekir.
 */
const [fileName, outPath] = process.argv.slice(2);

if (!fileName) {
  const files = listArchiveFiles(500);
  if (files.length === 0) {
    console.log("Kayitli arsiv dosyasi yok.");
    process.exit(0);
  }
  console.log(`${files.length} arsiv dosyasi:\n`);
  for (const f of files) {
    console.log(
      `${f.file_name}\n  tablo: ${f.table_name}  satir: ${f.row_count}  boyut: ${f.byte_size} bayt\n` +
        `  arasi: ${f.first_row_at} .. ${f.last_row_at}\n  icerik ozeti: ${f.content_sha256}\n`
    );
  }
  process.exit(0);
}

const { rows, record } = readArchiveFile(fileName);
const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

if (outPath) {
  writeFileSync(outPath, ndjson);
  console.log(`${record.row_count} satir yazildi: ${outPath}`);
} else {
  process.stdout.write(ndjson);
}
