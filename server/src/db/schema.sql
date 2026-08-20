-- Yakit Istasyonu Self-Servis Sistemi - Veritabani semasi
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,           -- super_admin | admin | operator | viewer
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,           -- kiosk adreslerinde kullanilir: /kiosk/:slug
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,         -- hex(pbkdf2)
  password_salt TEXT NOT NULL,         -- hex(random salt)
  password_iterations INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  station_id INTEGER REFERENCES stations(id), -- NULL = super_admin (tum istasyonlara erisir)
  active INTEGER NOT NULL DEFAULT 1,   -- 0/1
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                   -- ISO tarih, hesap kilidi
  email TEXT,
  phone TEXT,
  notify_email INTEGER NOT NULL DEFAULT 1, -- kritik alarm olustugunda e-posta gonderilsin mi
  notify_sms INTEGER NOT NULL DEFAULT 0,   -- kritik alarm olustugunda SMS gonderilsin mi
  reset_token_hash TEXT,               -- sifre sifirlama bagi (sha256, ham token asla saklanmaz)
  reset_token_expires_at TEXT,
  totp_secret TEXT,                    -- etkin 2FA sirri (base32); enable edilene kadar NULL
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_pending_secret TEXT,            -- kurulum sirasinda uretilen, henuz dogrulanmamis sir
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_station ON users(station_id);
-- idx_users_reset_token, reset_token_hash kolonu eski veritabanlarinda applyMigrations()
-- ile sonradan eklendigi icin burada degil db/index.ts'deki migration adiminda olusturulur
-- (aksi halde applySchema() bu index'i, kolon henuz yokken calistirmaya calisip hata verirdi).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                 -- rastgele opaque token (hash'i saklanir)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS fuel_prices (
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,             -- benzin | motorin | lpg
  label TEXT NOT NULL,
  price_per_liter REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (station_id, fuel_type)
);

CREATE TABLE IF NOT EXISTS pumps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  number INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', -- idle | reserved | dispensing | fault | offline
  fuel_types TEXT NOT NULL,            -- JSON dizi: ["benzin","motorin"]
  pos_x REAL NOT NULL DEFAULT 0,       -- istasyon haritasindaki konum (yuzde 0-100)
  pos_y REAL NOT NULL DEFAULT 0,
  fault_code TEXT,
  fault_message TEXT,
  current_transaction_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(station_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pumps_station ON pumps(station_id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  pump_id INTEGER NOT NULL REFERENCES pumps(id),
  plate TEXT NOT NULL,
  plate_source TEXT NOT NULL DEFAULT 'manual', -- manual | lpr
  fuel_type TEXT NOT NULL,
  amount_mode TEXT NOT NULL,           -- amount | liters | full_tank
  requested_amount REAL,               -- TL cinsinden istenen tutar
  requested_liters REAL,               -- litre cinsinden istenen miktar
  price_per_liter REAL NOT NULL,
  dispensed_liters REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'virtual_card',
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | authorized | captured | failed | refunded
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'created', -- created | paid | authorized | dispensing | completed | cancelled | failed
  kiosk_access_token TEXT NOT NULL,    -- kiosk terminalinin bu islemi sorgulamasi icin gereken tek kullanimlik token
  operator_user_id INTEGER REFERENCES users(id),
  discount_code TEXT,                  -- kullanilan kampanya kodu (varsa)
  discount_amount REAL NOT NULL DEFAULT 0, -- indirim/puan kullanimi ile dusen tutar (total_amount'tan degil, sadece odemeden dusulur)
  loyalty_points_redeemed REAL NOT NULL DEFAULT 0, -- bu islemde kullanilan sadakat puani
  loyalty_points_earned REAL NOT NULL DEFAULT 0,   -- bu islem tamamlaninca kazanilan sadakat puani
  started_at TEXT,
  completed_at TEXT,
  cancelled_reason TEXT,
  receipt_email TEXT,
  receipt_phone TEXT,
  receipt_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_station ON transactions(station_id);
CREATE INDEX IF NOT EXISTS idx_transactions_pump ON transactions(pump_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);

CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  pump_id INTEGER REFERENCES pumps(id),
  type TEXT NOT NULL,                  -- pump_fault | payment_failed | sensor | offline | manual
  severity TEXT NOT NULL DEFAULT 'warning', -- info | warning | critical
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | acknowledged | resolved
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_alarms_station ON alarms(station_id);
CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER REFERENCES stations(id), -- NULL: platform genelinde islem (ör. istasyon olusturma)
  user_id INTEGER REFERENCES users(id),
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,                        -- JSON
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_station ON audit_log(station_id);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  opening_note TEXT,
  closing_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_station ON shifts(station_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts(station_id, ended_at);

CREATE TABLE IF NOT EXISTS settings (
  station_id INTEGER NOT NULL REFERENCES stations(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (station_id, key)
);

CREATE TABLE IF NOT EXISTS fuel_tanks (
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,             -- benzin | motorin | lpg
  capacity_liters REAL NOT NULL DEFAULT 10000,
  current_liters REAL NOT NULL DEFAULT 0,
  low_stock_threshold_liters REAL NOT NULL DEFAULT 1000,
  average_cost_per_liter REAL NOT NULL DEFAULT 0, -- agirlikli ortalama alis maliyeti (TL/L); sadece maliyet girilen teslimatlarla guncellenir
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (station_id, fuel_type)
);
CREATE INDEX IF NOT EXISTS idx_fuel_tanks_station ON fuel_tanks(station_id);

CREATE TABLE IF NOT EXISTS fuel_stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,
  type TEXT NOT NULL,                  -- delivery | sale | adjustment
  liters REAL NOT NULL,                -- pozitif: stok girisi, negatif: cikis
  balance_after REAL NOT NULL,
  supplier TEXT,
  delivery_ref TEXT,
  note TEXT,
  unit_cost REAL,                      -- sadece delivery: opsiyonel alis maliyeti (TL/L)
  transaction_id INTEGER REFERENCES transactions(id),
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_stock_movements_station ON fuel_stock_movements(station_id, created_at);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  station_id INTEGER NOT NULL REFERENCES stations(id),
  plate TEXT NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (station_id, plate)
);

CREATE TABLE IF NOT EXISTS loyalty_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  plate TEXT NOT NULL,
  type TEXT NOT NULL,                  -- earn | redeem | refund | adjustment
  points REAL NOT NULL,                -- pozitif: bakiyeye eklenir, negatif: bakiyeden dusulur
  balance_after REAL NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id), -- manuel duzeltmede kim yapti
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_loyalty_movements_station_plate ON loyalty_movements(station_id, plate, created_at);

CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  code TEXT NOT NULL,
  type TEXT NOT NULL,                  -- percent | fixed
  value REAL NOT NULL,                 -- percent: 0-100, fixed: TL
  fuel_type TEXT,                      -- NULL = tum yakit tipleri
  max_uses INTEGER,                    -- NULL = sinirsiz
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE(station_id, code)
);
CREATE INDEX IF NOT EXISTS idx_discount_codes_station ON discount_codes(station_id, active);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  provider TEXT NOT NULL DEFAULT 'uyumsoft',
  provider_invoice_id TEXT,
  error_message TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_station ON invoices(station_id, created_at);

CREATE TABLE IF NOT EXISTS waybills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  movement_id INTEGER NOT NULL REFERENCES fuel_stock_movements(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  provider TEXT NOT NULL DEFAULT 'uyumsoft',
  provider_waybill_id TEXT,
  error_message TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(movement_id)
);
CREATE INDEX IF NOT EXISTS idx_waybills_station ON waybills(station_id, created_at);

CREATE TABLE IF NOT EXISTS pump_maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  pump_id INTEGER NOT NULL REFERENCES pumps(id),
  type TEXT NOT NULL DEFAULT 'maintenance', -- maintenance | note
  description TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pump_maintenance_pump ON pump_maintenance_logs(pump_id, created_at);

-- Bu semadan once olusturulmus istasyonlar icin varsayilan tank kayitlarini
-- olusturur. Idempotent'tir (INSERT OR IGNORE + PRIMARY KEY), her baslangicta
-- calisabilir; yeni istasyonlar zaten olusturulurken kendi tank kayitlarini alir.
INSERT OR IGNORE INTO fuel_tanks (station_id, fuel_type, capacity_liters, current_liters, low_stock_threshold_liters)
SELECT s.id, x.fuel_type, x.capacity, x.current, x.threshold
FROM stations s
CROSS JOIN (
  SELECT 'benzin' as fuel_type, 10000.0 as capacity, 0.0 as current, 1500.0 as threshold
  UNION ALL SELECT 'motorin', 10000.0, 0.0, 1500.0
  UNION ALL SELECT 'lpg', 5000.0, 0.0, 750.0
) x;
