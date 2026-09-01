import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");

/**
 * Uretim kesintisine yol acan gercek olay: schema.sql'e yeni bir kolon eklenip
 * (ör. fuel_orders.tracking_token) hemen ardindan o kolonu kullanan bir CREATE INDEX
 * eklendiginde, bu SADECE tertemiz bir kurulumda calisir. Halihazirda kurulu (production)
 * bir veritabaninda 'fuel_orders' tablosu ZATEN VAR oldugundan "CREATE TABLE IF NOT
 * EXISTS" no-op'tur - yeni kolon o an eklenmez (bu, ayri ve idempotent bir ensureColumn()
 * migration adimidir, bkz. db/index.ts applyMigrations()). Indeks ifadesi kolonu
 * varsayarsa, "no such column" hatasiyla applySchema()'yi (ve tum sunucu aciligini)
 * coktururdu - tam olarak bu yasandi (tracking_token, bkz. commit hotfix).
 *
 * Bu test, "eski" (yeni kolonlar olmadan) bir fuel_orders tablosu kurup TAM schema.sql'i
 * uzerinde calistirarak bu hata sinifini yakalar - stations.sync_token icin zaten
 * belgelenmis olan aynı yasagın (schema.sql'deki yorum) somut bir dogrulamasidir.
 */
describe("schema.sql - mevcut (eski) veritabanina karsi guvenli calisir", () => {
  it("yeni kolon eklenmis bir tabloya (fuel_orders) referans veren hicbir CREATE INDEX, 'no such column' ile patlamaz", () => {
    const db = new Database(":memory:");
    try {
      // Production'daki "eski" fuel_orders tablosunu simule eder: yalnizca
      // idx_fuel_orders_station'in ihtiyac duydugu kolonlar var, yeni eklenen
      // sutunlarin (tracking_token dahil) HICBIRI yok.
      db.exec(`CREATE TABLE fuel_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, station_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft')`);

      expect(() => db.exec(schemaSql)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
