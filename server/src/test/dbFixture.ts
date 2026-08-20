import { db } from "../db/index.js";
import type { FuelType, RoleName, StationRow, UserRow } from "../db/types.js";

let roleIds: Record<RoleName, number> | null = null;
let counter = 0;

/** roles tablosu schema.sql'de otomatik doldurulmaz (yalnizca seed.ts ile) - testler kendi rollerini garanti eder. */
function ensureRoles(): Record<RoleName, number> {
  if (roleIds) return roleIds;
  const roles: Array<{ name: RoleName; description: string }> = [
    { name: "super_admin", description: "" },
    { name: "admin", description: "" },
    { name: "operator", description: "" },
    { name: "viewer", description: "" },
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)");
  for (const r of roles) insert.run(r.name, r.description);
  const rows = db.prepare<[], { id: number; name: RoleName }>("SELECT id, name FROM roles").all();
  roleIds = Object.fromEntries(rows.map((r) => [r.name, r.id])) as Record<RoleName, number>;
  return roleIds;
}

const DEFAULT_TANKS: Array<{ fuelType: FuelType; capacity: number; current: number; threshold: number }> = [
  { fuelType: "benzin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "motorin", capacity: 10000, current: 0, threshold: 1500 },
  { fuelType: "lpg", capacity: 5000, current: 0, threshold: 750 },
];

/** Her testin kendi izole istasyonunu olusturur (paylasilan sabit veriye bagimliligi ve testler-arasi carpismayi onlemek icin), varsayilan tanklarla birlikte. */
export function createTestStation(): StationRow {
  counter += 1;
  const slug = `test-station-${Date.now()}-${counter}`;
  const result = db
    .prepare("INSERT INTO stations (slug, name, address) VALUES (?, ?, ?)")
    .run(slug, `Test Istasyon ${counter}`, "Test Adres");
  const station = db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ?").get(result.lastInsertRowid as number)!;

  const insertTank = db.prepare(
    "INSERT INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters) VALUES (?, ?, ?, ?, ?)"
  );
  for (const t of DEFAULT_TANKS) insertTank.run(station.id, t.fuelType, t.capacity, t.current, t.threshold);

  return station;
}

export function createTestUser(stationId: number | null, role: RoleName = "admin"): UserRow {
  const roles = ensureRoles();
  counter += 1;
  const username = `test-user-${Date.now()}-${counter}`;
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role_id, station_id)
       VALUES (?, ?, 'x', 'x', 1, ?, ?)`
    )
    .run(username, username, roles[role], stationId);
  return db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid as number)!;
}

export function createTestPump(stationId: number, fuelTypes: FuelType[] = ["benzin", "motorin", "lpg"]): number {
  const number = db.prepare<[number], { c: number }>("SELECT COUNT(*) as c FROM pumps WHERE station_id = ?").get(stationId)!.c + 1;
  const result = db
    .prepare("INSERT INTO pumps (station_id, number, label, status, fuel_types) VALUES (?, ?, ?, 'idle', ?)")
    .run(stationId, number, `Pompa ${number}`, JSON.stringify(fuelTypes));
  return result.lastInsertRowid as number;
}
