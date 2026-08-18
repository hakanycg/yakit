import { db } from "../db/index.js";
import type { RoleRow, StationRow } from "../db/types.js";
import { hashPassword, validatePasswordPolicy } from "../utils/password.js";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";

function ensureRoles(): Record<string, number> {
  const roles: Array<{ name: string; description: string }> = [
    { name: "admin", description: "Yonetici - tam yetki (kullanici yonetimi, ayarlar, audit log)" },
    { name: "operator", description: "Operator - pompa/islem/alarm yonetimi" },
    { name: "viewer", description: "Izleyici - salt okunur erisim" },
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)");
  for (const r of roles) insert.run(r.name, r.description);

  const rows = db.prepare<[], RoleRow>("SELECT * FROM roles").all();
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

function ensureAdmin(roleIds: Record<string, number>): void {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(env.SEED_ADMIN_USERNAME);
  if (existing) {
    logger.info(`Yonetici kullanicisi zaten mevcut: ${env.SEED_ADMIN_USERNAME}`);
    return;
  }

  const errors = validatePasswordPolicy(env.SEED_ADMIN_PASSWORD);
  if (errors.length > 0) {
    throw new Error(`SEED_ADMIN_PASSWORD sifre politikasini saglamiyor: ${errors.join(" ")}`);
  }

  const hashed = hashPassword(env.SEED_ADMIN_PASSWORD);
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, must_change_password)
     VALUES (?, 'Sistem Yoneticisi', ?, ?, ?, ?, 1)`
  ).run(env.SEED_ADMIN_USERNAME, hashed.hash, hashed.salt, hashed.iterations, roleIds.admin);

  logger.info(`Yonetici kullanicisi olusturuldu: ${env.SEED_ADMIN_USERNAME} (ilk girişte sifre degistirme zorunlu)`);
}

function ensureStationAndPumps(): void {
  let station = db.prepare<[], StationRow>("SELECT * FROM stations LIMIT 1").get();
  if (!station) {
    const result = db
      .prepare("INSERT INTO stations (name, address, latitude, longitude) VALUES (?, ?, ?, ?)")
      .run("Merkez Yakit Istasyonu", "Ataturk Bulvari No:1, Ankara", 39.9208, 32.8541);
    station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(result.lastInsertRowid as number)!;
  }

  const pumpCount = (db.prepare("SELECT COUNT(*) as c FROM pumps WHERE station_id = ?").get(station.id) as { c: number }).c;
  if (pumpCount === 0) {
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
}

function ensureFuelPrices(): void {
  const prices: Array<{ fuelType: string; label: string; price: number }> = [
    { fuelType: "benzin", label: "Kursunsuz Benzin 95", price: 44.5 },
    { fuelType: "motorin", label: "Motorin (Diesel)", price: 43.2 },
    { fuelType: "lpg", label: "Otogaz LPG", price: 21.9 },
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO fuel_prices (fuel_type, label, price_per_liter) VALUES (?, ?, ?)");
  for (const p of prices) insert.run(p.fuelType, p.label, p.price);
}

function main(): void {
  const roleIds = ensureRoles();
  ensureAdmin(roleIds);
  ensureStationAndPumps();
  ensureFuelPrices();
  logger.info("Seed islemi tamamlandi.");
}

main();
