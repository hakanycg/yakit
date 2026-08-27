import { db } from "../db/index.js";
import { hashPassword } from "../utils/password.js";

/**
 * Playwright e2e testleri (bkz. web/e2e/) için tohumlama betiği.
 *
 * server/src/scripts/seed.ts (gerçek/production kurulum tohumu) İLE KARIŞTIRILMAMALI:
 * bu betik yalnızca web/e2e/globalSetup.ts tarafından, tamamen tek kullanımlık bir
 * SQLite dosyasına (E2E_DATABASE_PATH) karşı çağrılır - hiçbir zaman gerçek veriye
 * dokunmaz. `db/index.ts` import edildiği anda schema zaten kurulur (applySchema/
 * applyMigrations orada modül yüklenirken çalışır), bu yüzden burada ayrıca
 * çağrılmasına gerek yok.
 *
 * Sabit değerler (istasyon slug'ı, plaka, fiyat, admin kimlik bilgileri) burada
 * DEĞİL web/e2e/constants.ts'te tanımlıdır ve globalSetup.ts tarafından ortam
 * değişkeni olarak buraya geçirilir - iki workspace arasında bir TS modülü paylaşılamadığı
 * için tek kaynak orasıdır.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`seedE2E.ts: ${name} ortam degiskeni gerekli (bkz. web/e2e/globalSetup.ts).`);
  return v;
}

const stationSlug = required("E2E_STATION_SLUG");
const stationName = process.env.E2E_STATION_NAME ?? "E2E Test Istasyonu";
const contactPhone = process.env.E2E_CONTACT_PHONE ?? null;
const pumpLabel = required("E2E_PUMP_LABEL");
const fuelType = required("E2E_FUEL_TYPE");
const pricePerLiter = Number(required("E2E_PRICE_PER_LITER"));
const plate = required("E2E_PLATE");
const fleetCompany = required("E2E_FLEET_COMPANY");
const fleetBalance = Number(required("E2E_FLEET_BALANCE"));
const adminUsername = required("E2E_ADMIN_USERNAME").toLowerCase();
const adminPassword = required("E2E_ADMIN_PASSWORD");
const deviceToken = required("E2E_DEVICE_TOKEN");

function ensureRole(name: string): number {
  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)").run(name, "");
  return db.prepare<[string], { id: number }>("SELECT id FROM roles WHERE name = ?").get(name)!.id;
}

// require_kiosk_token = 1 (varsayilan/gercekci production ayari): /api/kiosk/heartbeat
// ve /api/kiosk/support zaten bu ayardan BAGIMSIZ olarak her zaman gecerli bir cihaz
// tokeni istiyor (bkz. server/src/routes/kiosk.ts) - e2e bu yuzden gercek bir kiosk
// kurulumu gibi asagida bir station_kiosks kaydi + device_token olusturur.
const stationId = db
  .prepare(
    `INSERT INTO stations (slug, name, address, contact_phone, active, require_kiosk_token)
     VALUES (?, ?, 'E2E Test Adresi', ?, 1, 1)`
  )
  .run(stationSlug, stationName, contactPhone).lastInsertRowid as number;

const pumpId = db
  .prepare("INSERT INTO pumps (station_id, number, label, status, fuel_types) VALUES (?, 1, ?, 'idle', ?)")
  .run(stationId, pumpLabel, JSON.stringify([fuelType])).lastInsertRowid as number;

// pump_id = NULL: kiosk hicbir pompaya ONCEDEN BAGLI degil, musteri PumpStep'te
// kendisi secer (bkz. KioskFlow.tsx boundPump mantigi) - e2e akisi bu adimi da kapsasin diye.
db.prepare("INSERT INTO station_kiosks (station_id, label, device_token) VALUES (?, 'E2E Kiosk', ?)").run(
  stationId,
  deviceToken
);

db.prepare("INSERT INTO fuel_prices (station_id, fuel_type, label, price_per_liter) VALUES (?, ?, ?, ?)").run(
  stationId,
  fuelType,
  fuelType,
  pricePerLiter
);

// FuelStep, tank stogu 0 ise yakit dugmesini DISABLED yapar (bkz. web/src/kiosk/steps/FuelStep.tsx) -
// e2e'nin dolum akisini tamamlayabilmesi icin tankta gercek stok olmali.
db.prepare(
  "INSERT INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, 10000, 5000, 1000)"
).run(stationId, fuelType);

const fleetAccountId = db
  .prepare(
    "INSERT INTO fleet_accounts (station_id, company_name, billing_type, balance, active) VALUES (?, ?, 'prepaid', ?, 1)"
  )
  .run(stationId, fleetCompany, fleetBalance).lastInsertRowid as number;
db.prepare("INSERT INTO fleet_plates (fleet_account_id, plate) VALUES (?, ?)").run(fleetAccountId, plate);

// Destek talebi e2e'sinin, talebin GERCEKTEN sunucuya ulastigini ve kritik bir alarma
// donustugunu API uzerinden dogrulayabilmesi icin bir admin oturumu gerekir.
const adminRoleId = ensureRole("admin");
const hashed = hashPassword(adminPassword);
db.prepare(
  `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id, must_change_password)
   VALUES (?, 'E2E Admin', ?, ?, ?, ?, ?, 0)`
).run(adminUsername, hashed.hash, hashed.salt, hashed.iterations, adminRoleId, stationId);

// eslint-disable-next-line no-console
console.log(
  `seedE2E: istasyon #${stationId} (${stationSlug}), pompa #${pumpId}, filo hesabi #${fleetAccountId} (plaka ${plate}), admin '${adminUsername}' olusturuldu.`
);
