import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".server.pid.json");

/** globalSetup.ts'te elle baslatilan sunucu surecini kapatir (bkz. oradaki siralama notu). */
export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, "utf-8")) as { pid: number };
    process.kill(pid, "SIGTERM");
  } catch {
    // Surec zaten sonlanmis olabilir - kapatma en iyi cabadir (best-effort).
  } finally {
    rmSync(PID_FILE, { force: true });
  }
}
