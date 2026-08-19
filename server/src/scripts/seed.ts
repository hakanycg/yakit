import { db } from "../db/index.js";
import type { RoleRow, StationRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy } from "../utils/password.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";

const DEFAULT_STATION_SLUG = "merkez";

function ensureRoles(): Record<string, number> {
  const roles: Array<{ name: string; description: string }> = [
    { name: "super_admin", description: "Platform sahibi - tum istasyonlara ve ekiplere erisir" },
    { name: "admin", description: "Istasyon sahibi/yoneticisi - kendi istasyonunda tam yetki" },
    { name: "operator", description: "Operator - pompa/islem/alarm yonetimi" },
    { name: "viewer", description: "Izleyici - salt okunur erisim" },
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)");
  for (const r of roles) insert.run(r.name, r.description);

  const rows = db.prepare<[], RoleRow>("SELECT * FROM roles").all();
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

function ensureSuperAdmin(roleIds: Record<string, number>): void {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(env.SEED_ADMIN_USERNAME);
  if (existing) {
    logger.info(`Super admin kullanicisi zaten mevcut: ${env.SEED_ADMIN_USERNAME}`);
    return;
  }

  const errors = validatePasswordPolicy(env.SEED_ADMIN_PASSWORD);
  if (errors.length > 0) {
    throw new Error(`SEED_ADMIN_PASSWORD sifre politikasini saglamiyor: ${errors.join(" ")}`);
  }

  const hashed = hashPassword(env.SEED_ADMIN_PASSWORD);
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id, must_change_password)
     VALUES (?, 'Platform Yoneticisi', ?, ?, ?, ?, NULL, 1)`
  ).run(env.SEED_ADMIN_USERNAME, hashed.hash, hashed.salt, hashed.iterations, roleIds.super_admin);

  logger.info(`Super admin kullanicisi olusturuldu: ${env.SEED_ADMIN_USERNAME} (tum istasyonlara erisir, ilk girişte sifre degistirme zorunlu)`);
}

function ensureDefaultStation(): StationRow {
  let station = db.prepare<[string], StationRow>("SELECT * FROM stations WHERE slug = ?").get(DEFAULT_STATION_SLUG);
  if (!station) {
    const result = db
      .prepare("INSERT INTO stations (slug, name, address, latitude, longitude) VALUES (?, ?, ?, ?, ?)")
      .run(DEFAULT_STATION_SLUG, "Merkez Yakit Istasyonu", "Ataturk Bulvari No:1, Ankara", 39.9208, 32.8541);
    station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(result.lastInsertRowid as number)!;
    logger.info(`Istasyon olusturuldu: ${station.name} (/kiosk/${station.slug})`);
  }
  return station;
}

function ensureStationOwner(station: StationRow, roleIds: Record<string, number>): void {
  const username = `${station.slug}-admin`;
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) {
    logger.info(`Istasyon yoneticisi zaten mevcut: ${username}`);
    return;
  }

  const errors = validatePasswordPolicy(env.SEED_ADMIN_PASSWORD);
  if (errors.length > 0) {
    throw new Error(`SEED_ADMIN_PASSWORD sifre politikasini saglamiyor: ${errors.join(" ")}`);
  }

  const hashed = hashPassword(env.SEED_ADMIN_PASSWORD);
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(username, `${station.name} Yoneticisi`, hashed.hash, hashed.salt, hashed.iterations, roleIds.admin, station.id);

  logger.info(`Istasyon yoneticisi olusturuldu: ${username} (sifre: SEED_ADMIN_PASSWORD ile ayni, ilk girişte degistirme zorunlu)`);
}

function ensurePumps(station: StationRow): void {
  const pumpCount = (db.prepare("SELECT COUNT(*) as c FROM pumps WHERE station_id = ?").get(station.id) as { c: number }).c;
  if (pumpCount > 0) return;

  const positions = [
    { x: 20, y: 30 },
    { x: 45, y: 30 },
    { x: 20, y: 65 },
    { x: 45, y: 65 },
  ];
  const insert = db.prepare(
    `INSERT INTO pumps (station_id, number, label, status, fuel_types, pos_x, pos_y) VALUES (?, ?, ?, 'idle', ?, ?, ?)`
  );
  for (let i = 0; i < 4; i++) {
    const pos = positions[i]!;
    insert.run(station.id, i + 1, `Pompa ${i + 1}`, JSON.stringify(["benzin", "motorin", "lpg"]), pos.x, pos.y);
  }
  logger.info("4 pompa olusturuldu.");
}

function ensureFuelPrices(station: StationRow): void {
  const prices: Array<{ fuelType: string; label: string; price: number }> = [
    { fuelType: "benzin", label: "Kursunsuz Benzin 95", price: 44.5 },
    { fuelType: "motorin", label: "Motorin (Diesel)", price: 43.2 },
    { fuelType: "lpg", label: "Otogaz LPG", price: 21.9 },
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO fuel_prices (station_id, fuel_type, label, price_per_liter) VALUES (?, ?, ?, ?)"
  );
  for (const p of prices) insert.run(station.id, p.fuelType, p.label, p.price);
}

function ensureFuelTanks(station: StationRow): void {
  const tanks: Array<{ fuelType: string; capacity: number; current: number; threshold: number }> = [
    { fuelType: "benzin", capacity: 10000, current: 6000, threshold: 1500 },
    { fuelType: "motorin", capacity: 10000, current: 6000, threshold: 1500 },
    { fuelType: "lpg", capacity: 5000, current: 3000, threshold: 750 },
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, ?, ?, ?)"
  );
  for (const t of tanks) insert.run(station.id, t.fuelType, t.capacity, t.current, t.threshold);
}

function main(): void {
  const roleIds = ensureRoles();
  ensureSuperAdmin(roleIds);
  const station = ensureDefaultStation();
  ensureStationOwner(station, roleIds);
  ensurePumps(station);
  ensureFuelPrices(station);
  ensureFuelTanks(station);
  logger.info("Seed islemi tamamlandi.");
  logger.info(`Kiosk adresi: /kiosk/${station.slug}`);
}

main();
