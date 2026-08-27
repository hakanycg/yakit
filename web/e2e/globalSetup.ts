import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_CONTACT_PHONE,
  E2E_DATABASE_PATH,
  E2E_DEVICE_TOKEN,
  E2E_FLEET_BALANCE,
  E2E_FLEET_COMPANY,
  E2E_FUEL_TYPE,
  E2E_PLATE,
  E2E_PORT,
  E2E_PRICE_PER_LITER,
  E2E_PUMP_LABEL,
  E2E_SESSION_SECRET,
  E2E_STATION_NAME,
  E2E_STATION_SLUG,
} from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..");
const SERVER_DIR = path.resolve(WEB_DIR, "../server");
const PID_FILE = path.resolve(__dirname, ".server.pid.json");

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Sunucu ${timeoutMs}ms icinde ayaga kalkmadi (${url}): ${String(lastError)}`);
}

/**
 * Playwright'in webServer eklentisi (plugin) ile globalSetup'in calisma SIRASI garanti
 * DEGIL - webServer, globalSetup TAMAMLANMADAN once baslayabiliyor. Bu, sunucunun
 * bos/henuz-tohumlanmamis bir SQLite dosyasini ACIP baglantiyi ACIK TUTMASINA yol
 * acabiliyordu: seedE2E.ts o dosyayi SONRADAN yeniden yazsa bile (silip yeniden
 * olusturarak), sunucunun surecinde onceden ACIK duran dosya tanitici HALA ESKI
 * (bos) inode'a bakiyordu - "İstasyon Bulunamadı" hatasi tam olarak boyle ortaya
 * cikti. Cozum: sirayi KENDIMIZ garanti ederiz - sunucuyu Playwright'e degil, BURADA,
 * tohumlama TAMAMLANDIKTAN SONRA elle baslatiriz (bkz. globalTeardown.ts'teki
 * karsilik gelen kapatma).
 */
export default async function globalSetup(): Promise<void> {
  const dbPath = path.resolve(SERVER_DIR, E2E_DATABASE_PATH);
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }

  execFileSync("npm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });

  execFileSync("npx", ["tsx", "src/scripts/seedE2E.ts"], {
    cwd: SERVER_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_PATH: E2E_DATABASE_PATH,
      SESSION_SECRET: E2E_SESSION_SECRET,
      E2E_STATION_SLUG,
      E2E_STATION_NAME,
      E2E_CONTACT_PHONE,
      E2E_PUMP_LABEL,
      E2E_FUEL_TYPE,
      E2E_PRICE_PER_LITER: String(E2E_PRICE_PER_LITER),
      E2E_PLATE,
      E2E_FLEET_COMPANY,
      E2E_FLEET_BALANCE: String(E2E_FLEET_BALANCE),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_PASSWORD,
      E2E_DEVICE_TOKEN,
    },
  });

  const baseURL = `http://127.0.0.1:${E2E_PORT}`;
  const child: ChildProcess = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(E2E_PORT),
      DATABASE_PATH: E2E_DATABASE_PATH,
      SESSION_SECRET: E2E_SESSION_SECRET,
      WEB_ORIGIN: baseURL,
      COOKIE_SECURE: "false",
    },
  });
  child.unref();

  if (!child.pid) throw new Error("e2e sunucusu baslatilamadi (pid yok).");
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid }));

  await waitForHealth(`${baseURL}/api/health`, 30_000);
}
