import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".server.pid.json");

/**
 * globalSetup.ts'te elle baslatilan sunucu surecini kapatir (bkz. oradaki siralama notu).
 *
 * KRITIK: `process.kill(pid, ...)` YETMEZ. globalSetup.ts sunucuyu `spawn("npx", ["tsx", ...])`
 * ile baslatiyor - `child.pid` bu cagrinin PID'idir, ama npx kendi altinda BASKA BIR SURECE
 * (tsx'in gercek node sureci) gecebilir/onu spawn edebilir. O zaman kaydedilen PID ya zaten
 * sonlanmis olur ya da yalnizca ust kabugu oldurur; asil sunucu (ve dinledigi port) ORPHAN
 * olarak CALISMAYA DEVAM EDER. Bir sonraki test kosusu globalSetup'ta veritabanini silip
 * yeniden tohumlasa bile, port 4310'da hala bu ESKI surec dinliyor olur ve health-check onu
 * "yeni sunucu hazir" sanip gecer - test bundan sonra YANLIS (eski, farkli veriye sahip)
 * sunucuya konusur. Bu, gercekten yasandi: "kiosk-help-call" testi aralikli olarak, destek
 * talebi alarm dedup penceresi (bkz. supportService.ts ALARM_DEDUP_WINDOW_MS) onceki bir
 * kosunun "hayalet" sunucusundaki eski bir kayda takilarak basarisiz oluyordu.
 *
 * Cozum: `detached: true` ile spawn edilen surec kendi process GRUBUNUN lideri olur (pgid ==
 * kendi pid'i); negatif PID ile sinyal gonderilirse (`process.kill(-pid, ...)`) npx'in
 * spawn ettigi TUM alt surecler de (ayrica detach edilmedikleri surece) ayni gruba dahil
 * olduklarindan birlikte sonlanir.
 */
export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, "utf-8")) as { pid: number };
    process.kill(-pid, "SIGTERM");
  } catch {
    // Surec zaten sonlanmis olabilir - kapatma en iyi cabadir (best-effort).
  } finally {
    rmSync(PID_FILE, { force: true });
  }
}
