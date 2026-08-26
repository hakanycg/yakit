import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config.js";
import { generateStationCode } from "../utils/stationCode.js";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = resolve(process.cwd(), env.DATABASE_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

export function applySchema(): void {
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
}

/** Halihazirda kurulu (schema.sql'deki CREATE TABLE ile olusmamis) veritabanlarina sonradan
 * eklenen kolonlari, mevcut degilse ekler. Tablo/kolon adlari her zaman sabit degerlerdir
 * (kullanici girdisinden gelmez), bu yuzden template string ile SQL'e yazilmalari guvenlidir. */
function ensureColumn(table: string, column: string, definition: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export function applyMigrations(): void {
  ensureColumn("transactions", "discount_code", "TEXT");
  ensureColumn("transactions", "discount_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn("transactions", "loyalty_points_redeemed", "REAL NOT NULL DEFAULT 0");
  ensureColumn("transactions", "loyalty_points_earned", "REAL NOT NULL DEFAULT 0");
  ensureColumn("users", "reset_token_hash", "TEXT");
  ensureColumn("users", "reset_token_expires_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token_hash)");
  ensureColumn("users", "totp_secret", "TEXT");
  ensureColumn("users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "totp_pending_secret", "TEXT");
  ensureColumn("fuel_tanks", "average_cost_per_liter", "REAL NOT NULL DEFAULT 0");
  ensureColumn("fuel_stock_movements", "unit_cost", "REAL");
  ensureColumn("stations", "sync_token", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_sync_token ON stations(sync_token) WHERE sync_token IS NOT NULL");
  ensureColumn("fleet_accounts", "contact_email", "TEXT");
  ensureColumn("fleet_accounts", "contact_phone", "TEXT");
  ensureColumn("fleet_accounts", "low_balance_threshold", "REAL");
  ensureColumn("fleet_accounts", "payment_term_days", "INTEGER");
  ensureColumn("fleet_accounts", "overdue_block_days", "INTEGER");
  ensureColumn("fleet_invoices", "due_date", "TEXT");

  // Odeme hic sonuclanmadan iptal edilen eski islemler payment_status='processing'
  // olarak kalmisti ve gun sonu mutabakatindaki "Askida Kalan Islemler" listesinde
  // "parasi bloke edilmis" gibi gorunuyorlardi (bkz. transactionService.clearedPaymentStatus).
  // Yalnizca tutari SIFIR olan satirlar duzeltiliyor: ortada gercekten para varsa
  // o satirin mutabakatta gorunmeye devam etmesi gerekir.
  db.prepare(
    "UPDATE transactions SET payment_status = 'cancelled' WHERE status = 'cancelled' AND payment_status = 'processing' AND total_amount = 0"
  ).run();

  ensureColumn("station_kiosks", "device_token", "TEXT");
  ensureColumn("station_kiosks", "last_seen_at", "TEXT");
  // Mevcut kurulumlarda NULL kalir: bagli pompasi olmayan kiosk eskisi gibi
  // musteriye pompa sectirmeye devam eder, davranis degismez.
  ensureColumn("station_kiosks", "pump_id", "INTEGER REFERENCES pumps(id)");
  ensureColumn("stations", "contact_phone", "TEXT");
  // Denetim kaydi zenginlestirmesi. Eski satirlarda bu alanlar NULL kalir - o kayitlarin
  // yazildigi anda bu bilgi gercekten toplanmiyordu; geriye donuk uydurmak yaniltici olurdu.
  ensureColumn("audit_log", "actor_type", "TEXT");
  ensureColumn("audit_log", "role", "TEXT");
  ensureColumn("audit_log", "user_agent", "TEXT");
  // Sema henuz "source" kolonu olmadan olusmus kurulumlar: mevcut tum olcumler elle
  // girilmistir, varsayilan dogru degeri zaten verir.
  // Kiraci (dagitim sirketi) katmani. Roller yalnizca seed.ts'te olusturuluyor ve seed
  // acilistan sonra calistirilmayabilir; tenant_admin rolu burada da garanti edilmezse
  // mevcut kurulumlarda ozellik sessizce calismaz.
  db.exec(
    "INSERT OR IGNORE INTO roles (name, description) VALUES ('tenant_admin', 'Dagitim sirketi yoneticisi - yalnizca kendi istasyonlarina erisir')"
  );
  ensureColumn("stations", "tenant_id", "INTEGER REFERENCES tenants(id)");
  ensureColumn("users", "tenant_id", "INTEGER REFERENCES tenants(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_stations_tenant ON stations(tenant_id)");

  // Kritik alarm yukseltme: cevaplanmayan alarmin kacinci asamada oldugu ve en son ne
  // zaman bildirildigi (bkz. services/alarmEscalationService.ts).
  ensureColumn("alarms", "escalation_level", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("alarms", "last_notified_at", "TEXT");

  // Teslimat kabul farki: irsaliyedeki miktar ile tanka FIILEN giren miktar ayri
  // kolonlarda tutulur. Tek bir "liters" alani, eksik gelen bir tankeri tespit
  // edilemez hale getiriyordu - bkz. services/deliveryVarianceService.ts.
  ensureColumn("fuel_stock_movements", "declared_liters", "REAL");
  ensureColumn("fuel_stock_movements", "measured_before_liters", "REAL");
  ensureColumn("fuel_stock_movements", "measured_after_liters", "REAL");
  ensureColumn("fuel_stock_movements", "delivery_variance_liters", "REAL");
  ensureColumn("fuel_stock_movements", "delivery_variance_pct", "REAL");

  // Bir hareket YALNIZCA BIR KEZ faturalanabilir: donem faturasinin kapsami tarihle
  // degil bu kolonla belirlenir, boylece bir dolumun iki faturada birden cikmasi
  // (kurumsal musteriye ciftfaturalama) sema seviyesinde imkansiz hale gelir.
  ensureColumn("fleet_movements", "fleet_invoice_id", "INTEGER REFERENCES fleet_invoices(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fleet_movements_invoice ON fleet_movements(fleet_invoice_id)");

  ensureColumn("fuel_tank_readings", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn("fuel_tank_readings", "temperature_celsius", "REAL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_station_kiosks_device_token ON station_kiosks(device_token) WHERE device_token IS NOT NULL");

  // Kiosk cihaz dogrulamasi YENI istasyonlarda varsayilan olarak aciktir (schema.sql'de
  // DEFAULT 1). Ancak halihazirda calisan kurulumlarda kiosk'larin henuz tokeni yok;
  // kolonu 1 ile eklemek o istasyonlarin kiosk ekranlarini aninda calismaz hale getirirdi.
  // Bu yuzden kolon ILK kez eklendiginde mevcut satirlar 0'a cekilir - yonetici, kiosk
  // tokenlerini dagittiktan sonra Istasyonlar sayfasindan bunu kendisi acar.
  const addedRequireToken = ensureColumn("stations", "require_kiosk_token", "INTEGER NOT NULL DEFAULT 1");
  if (addedRequireToken) db.exec("UPDATE stations SET require_kiosk_token = 0");

  ensureColumn("stations", "code", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_code ON stations(code) WHERE code IS NOT NULL");
  backfillStationCodes();
  backfillKioskDeviceTokens();
}

/** Bu ozellikten once olusturulmus kiosk kayitlarina da birer cihaz tokeni verir. */
function backfillKioskDeviceTokens(): void {
  const rows = db.prepare("SELECT id FROM station_kiosks WHERE device_token IS NULL OR device_token = ''").all() as Array<{ id: number }>;
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE station_kiosks SET device_token = ? WHERE id = ?");
  for (const row of rows) update.run(randomBytes(32).toString("hex"), row.id);
}

/** Kodu olmayan istasyonlara (kolon yeni eklendi veya kayit eski) benzersiz bir "STM1234" atar. */
function backfillStationCodes(): void {
  const rows = db.prepare("SELECT id FROM stations WHERE code IS NULL OR code = ''").all() as Array<{ id: number }>;
  if (rows.length === 0) return;
  const isTaken = (code: string) => !!db.prepare("SELECT 1 FROM stations WHERE code = ?").get(code);
  const update = db.prepare("UPDATE stations SET code = ? WHERE id = ?");
  for (const row of rows) update.run(generateStationCode(isTaken), row.id);
}

applySchema();
applyMigrations();
