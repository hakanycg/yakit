import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config.js";

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
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function applyMigrations(): void {
  ensureColumn("transactions", "discount_code", "TEXT");
  ensureColumn("transactions", "discount_amount", "REAL NOT NULL DEFAULT 0");
  ensureColumn("transactions", "loyalty_points_redeemed", "REAL NOT NULL DEFAULT 0");
  ensureColumn("transactions", "loyalty_points_earned", "REAL NOT NULL DEFAULT 0");
  ensureColumn("users", "reset_token_hash", "TEXT");
  ensureColumn("users", "reset_token_expires_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token_hash)");
}

applySchema();
applyMigrations();
