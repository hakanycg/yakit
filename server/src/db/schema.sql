-- Yakit Istasyonu Self-Servis Sistemi - Veritabani semasi
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,           -- super_admin | tenant_admin | admin | operator | viewer
  description TEXT NOT NULL DEFAULT ''
);

-- Kiraci (dagitim sirketi / bayi grubu).
--
-- Bir dagitici yalnizca KENDI istasyonlarini gorur. Bu izolasyonun tek zorlandigi yer
-- attachStationScope'tur (bkz. middleware/auth.ts): istasyona bagli tum veri zaten
-- req.stationId uzerinden akiyor, dolayisiyla "hangi istasyona erisilebilir" sorusunu
-- orada cevaplamak butun sorgulari kapsar.
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,           -- eski kiosk adresi: /kiosk/:slug (geriye donuk destek icin korunuyor)
  tenant_id INTEGER REFERENCES tenants(id),  -- NULL = platformun kendi istasyonu (bir dagiticiya bagli degil)
  code TEXT UNIQUE,                    -- "STM1234" - kiosk adresi (/kiosk/STM1234) ve destek/envanter kimligi. SIR DEGILDIR (bkz. utils/stationCode.ts)
  require_kiosk_token INTEGER NOT NULL DEFAULT 1,  -- 1: kiosk uclarinda cihaz tokeni zorunlu (bkz. middleware/kioskDevice.ts)
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  sync_token TEXT,                     -- istasyon ajaninin /api/sync/* uclarinda kimlik dogrulamasi icin (bkz. syncService.ts)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- sync_token indeksi burada DEGIL, db/index.ts'deki applyMigrations()'da olusturuluyor:
-- CREATE TABLE IF NOT EXISTS, halihazirda var olan (production) 'stations' tablosunu
-- DEGISTIRMEZ (no-op), yani sync_token kolonu bu blokla eklenmis olmaz. Bu indeksi
-- burada, CREATE TABLE'in hemen ardinda olusturmaya calismak, mevcut veritabanlarinda
-- kolon henuz yokken calisip "no such column: sync_token" hatasiyla applySchema()'yi
-- (ve dolayisiyla tum sunucu baslatmasini) crash-loop'a sokar - bu gercekten yasandi.

-- Bir istasyonda TEK degil, genelde POMPA/ADA basina AYRI bir fiziksel kiosk PC'si
-- olur (ör. "Pompa 1-2 Adasi" icin bir kiosk, "Pompa 3-4" icin baska bir kiosk).
-- Bu tablo, uzak masaustu erisimi (AnyDesk vb.) icin her fiziksel kiosk'un kimligini
-- serbest bir etiketle (hangi pompa/ada oldugunu personelin anlayacagi bir metin)
-- eslestirir - bkz. stations.ts. Etiket serbest metindir, pompalarla katı bir iliski
-- (foreign key) KURULMAZ; bu salt bir uzaktan-erisim not defteridir, canli islem
-- akisinin (kiosk web uygulamasinin) hangi pompalari gosterdigiyle ilgisi yoktur.
CREATE TABLE IF NOT EXISTS station_kiosks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  label TEXT NOT NULL,                 -- ör. "Pompa 1-2 Adasi"
  anydesk_id TEXT,
  device_token TEXT,                   -- bu fiziksel kiosk'un kimligi; kiosk uclarinda x-kiosk-token-device basligiyla gonderilir
  last_seen_at TEXT,                   -- token en son ne zaman kullanildi (kurulum dogrulamasi/teshis icin)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_station_kiosks_station ON station_kiosks(station_id);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,         -- hex(pbkdf2)
  password_salt TEXT NOT NULL,         -- hex(random salt)
  password_iterations INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  station_id INTEGER REFERENCES stations(id), -- NULL = super_admin veya tenant_admin (tek bir istasyona bagli degil)
  -- tenant_admin icin zorunlu: kullanicinin yonetebilecegi istasyonlar bu kiraciyla sinirlidir.
  -- super_admin ve istasyon rollerinde NULL'dir.
  tenant_id INTEGER REFERENCES tenants(id),
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

-- Fiziksel tank olcumleri (daldirma cubugu / seviye probu) ve kayit stoguyla farki.
-- Personelsiz istasyonda tanki gozle kontrol eden kimse olmadigi icin sizinti, ayari
-- kaymis pompa veya kayit disi cekimi yakalamanin tek yolu bu karsilastirmadir.
CREATE TABLE IF NOT EXISTS fuel_tank_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,
  measured_liters REAL NOT NULL,       -- fiziksel olcum
  book_liters REAL NOT NULL,           -- olcum anindaki kayit stogu
  variance_liters REAL NOT NULL,       -- measured - book (negatif: kayip, pozitif: fazla)
  -- Sapma orani, tank kapasitesine degil ONCEKI OLCUMDEN BU YANA tanktan gecen
  -- hacme (satis + teslimat) bolunerek hesaplanir: 50.000 L'de 200 L kayip normal
  -- tolerans icindeyken, 2.000 L'de 200 L kayip ciddi bir sorundur.
  throughput_liters REAL NOT NULL,
  variance_pct REAL NOT NULL,
  previous_reading_id INTEGER REFERENCES fuel_tank_readings(id),
  -- manual: personel daldirma cubuguyla olcup girdi. auto: seviye probu okudu
  -- (bkz. tankGaugeDriver.ts). Panelde "kim olctu" sutunu bos gorunmesin diye ayrilir.
  source TEXT NOT NULL DEFAULT 'manual',
  temperature_celsius REAL,            -- prob destekliyorsa; genlesme mi kayip mi ayirmaya yardim eder
  alarm_id INTEGER REFERENCES alarms(id),
  note TEXT,
  measured_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_tank_readings_station ON fuel_tank_readings(station_id, fuel_type, measured_at);

-- Gun sonu kasa/odeme mutabakati: sistemin hesapladigi tahsilat ile hesaba GERCEKTEN
-- gecen tutarin karsilastirilmasi. Yakit sapmasiyla ayni mantik - orada kayit stogu
-- fiziksel olcumle, burada kayit tahsilati banka/POS ekstresiyle karsilastirilir.
CREATE TABLE IF NOT EXISTS daily_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  business_date TEXT NOT NULL,         -- YYYY-MM-DD, istasyonun YEREL is gunu (UTC degil)
  expected_total REAL NOT NULL,        -- sistemin kaydina gore tahsil edilmis olmasi gereken tutar
  declared_total REAL NOT NULL,        -- hesaba/kasaya gercekten gecen tutar (ekstreden girilir)
  difference REAL NOT NULL,            -- declared - expected (eksi: eksik yatmis)
  -- Kapanis anindaki kirilim FOTOGRAF olarak saklanir. Sonradan gelen iade/duzeltmeler
  -- yeniden hesaplanan bir rakami degistirirdi ve kapatilmis gun, imzalanan rakamla
  -- artik tutmazdi (bkz. fuel_tank_readings.book_liters ile ayni gerekce).
  breakdown_json TEXT NOT NULL,
  pending_count INTEGER NOT NULL,      -- kapanis aninda askida kalan (para bloke, is bitmemis) islem sayisi
  note TEXT,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(station_id, business_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_reconciliations_station ON daily_reconciliations(station_id, business_date);

-- Kiosk'tan gelen musteri destek talepleri.
--
-- Personelsiz istasyonda karti cekilip yakit akmayan ya da tabancayi calistiramayan
-- bir musterinin baska hicbir yolu yok: ekranin ona soyledigi tek sey "istasyon
-- yoneticinizle iletisime gecin" idi - personeli olmayan bir istasyonda. Bu tablo o
-- deligi kapatir.
CREATE TABLE IF NOT EXISTS support_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  kiosk_id INTEGER REFERENCES station_kiosks(id),
  pump_id INTEGER REFERENCES pumps(id),
  transaction_id INTEGER REFERENCES transactions(id),
  category TEXT NOT NULL,              -- payment | dispenser | receipt | other
  -- Musterinin serbest metni. KVKK geregi zorunlu degildir ve panelde ham gosterilir;
  -- plaka/telefon gibi kimlik bilgileri ISTENMEZ, kendisi yazarsa da o an zaten
  -- islemin kendi kaydinda mevcuttur.
  message TEXT,
  contact_phone TEXT,                  -- musteri geri aranmak isterse (opsiyonel)
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  alarm_id INTEGER REFERENCES alarms(id),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_support_requests_station ON support_requests(station_id, status, created_at);

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

-- Filo/kurumsal musteri hesaplari: sirketlerin birden fazla plakasini tek bir
-- bakiyeye (on odemeli) veya kredi limitine (sonradan faturalandirma) baglar.
CREATE TABLE IF NOT EXISTS fleet_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  company_name TEXT NOT NULL,
  vkn TEXT,
  billing_type TEXT NOT NULL DEFAULT 'prepaid', -- prepaid | postpaid
  balance REAL NOT NULL DEFAULT 0,     -- prepaid: kalan bakiye; postpaid: faturalandirilmamis birikmis borc
  credit_limit REAL,                   -- yalnizca postpaid icin ust sinir (NULL = sinirsiz)
  active INTEGER NOT NULL DEFAULT 1,
  contact_email TEXT,                  -- dusuk bakiye uyarisinin gonderilecegi sirket yetkilisi e-postasi
  contact_phone TEXT,                  -- dusuk bakiye uyarisinin gonderilecegi sirket yetkilisi telefonu (SMS)
  low_balance_threshold REAL,          -- yalnizca prepaid: bakiye bunun altina dusunce uyari gonderilir (NULL = kapali)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_accounts_station ON fleet_accounts(station_id, active);

CREATE TABLE IF NOT EXISTS fleet_plates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_account_id INTEGER NOT NULL REFERENCES fleet_accounts(id),
  plate TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(fleet_account_id, plate)
);
CREATE INDEX IF NOT EXISTS idx_fleet_plates_plate ON fleet_plates(plate);

CREATE TABLE IF NOT EXISTS fleet_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_account_id INTEGER NOT NULL REFERENCES fleet_accounts(id),
  type TEXT NOT NULL,                  -- topup | charge | refund | adjustment
  amount REAL NOT NULL,                -- topup/refund/pozitif adjustment bakiyeyi ARTIRIR, charge DUSURUR
  balance_after REAL NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fleet_movements_account ON fleet_movements(fleet_account_id, created_at);

-- Filo musteri self-servis portali.
--
-- Sirket yetkilisi personel DEGILDIR: users tablosuna bir rol olarak eklemek, bir
-- yetki kontrolundeki tek bir hata yuzunden dis bir sirketin istasyon verisine
-- erisebilmesi demek olurdu. Bu yuzden portal kimligi ayri tabloda, ayri cerezde ve
-- ayri middleware'de durur (bkz. middleware/fleetPortalAuth.ts) - kiosk cihaz
-- tokeninin de personel oturumundan ayri tutulmasiyla ayni gerekce.
CREATE TABLE IF NOT EXISTS fleet_portal_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,          -- kucuk harfe normalize edilerek saklanir
  display_name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);

-- Bir sirket ayni zincirin birden fazla istasyonunda yakit aliyorsa her istasyonda
-- AYRI bir fleet_accounts kaydi olur. Portal kullanicisini tek hesaba baglamak, o
-- sirkete istasyon sayisi kadar sifre vermek demekti; bu yuzden baglanti cok-cok.
CREATE TABLE IF NOT EXISTS fleet_portal_user_accounts (
  portal_user_id INTEGER NOT NULL REFERENCES fleet_portal_users(id) ON DELETE CASCADE,
  fleet_account_id INTEGER NOT NULL REFERENCES fleet_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (portal_user_id, fleet_account_id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_portal_links_account ON fleet_portal_user_accounts(fleet_account_id);

CREATE TABLE IF NOT EXISTS fleet_portal_sessions (
  id TEXT PRIMARY KEY,                 -- token'in SHA-256 hash'i (ham token saklanmaz)
  portal_user_id INTEGER NOT NULL REFERENCES fleet_portal_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fleet_portal_sessions_user ON fleet_portal_sessions(portal_user_id);
CREATE INDEX IF NOT EXISTS idx_fleet_portal_sessions_expires ON fleet_portal_sessions(expires_at);

-- Fiyat seffafligi ekrani icin yakit fiyati her degistiginde bir satir eklenir
-- (audit_log genel amacli oldugundan station+fuel_type bazinda sorgulamak icin
-- ayri, indeksli bir tablo daha uygundur).
CREATE TABLE IF NOT EXISTS fuel_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,
  price_per_liter REAL NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_price_history_station_fuel ON fuel_price_history(station_id, fuel_type, created_at);

-- Ayni plakanin kisa surede tekrarlanan islemlerini (anormal siklik) tespit
-- etmek icin - bkz. transactionService.ts checkPlateFrequencyAnomaly().
CREATE INDEX IF NOT EXISTS idx_transactions_station_plate_created ON transactions(station_id, plate, created_at);

-- Offline-queue mimarisi: istasyondaki yerel ajanin merkez sunucuyla en son ne
-- zaman haberlestigini izler. last_heartbeat_at ajanin "hayattayim" sinyali,
-- last_synced_at ise kuyruktaki olaylarin merkeze basariyla ulastigi son andir.
-- Hic satiri olmayan bir istasyon, ajan henuz kurulmamis demektir (offline
-- alarmi bu yuzden yalniz burada satiri OLAN istasyonlar icin uretilir - bkz.
-- syncService.ts checkOfflineStations()).
CREATE TABLE IF NOT EXISTS station_sync_state (
  station_id INTEGER PRIMARY KEY REFERENCES stations(id),
  last_heartbeat_at TEXT,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Istasyon ajaninin, baglanti kesintisi sirasinda yerel kuyruguna aldigi islem
-- olaylarini merkeze gonderdiginde islenen kayit. client_event_id ajanin
-- urettigi UUID'dir; ayni olay baglanti kararsizligi yuzunden tekrar
-- gonderilirse (retry) UNIQUE kisiti sayesinde iki kez islenmez (idempotency).
CREATE TABLE IF NOT EXISTS station_sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  client_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,            -- ör. transaction_created | dispensing_started | transaction_completed | payment_result
  payload TEXT NOT NULL,               -- JSON
  status TEXT NOT NULL DEFAULT 'received', -- received | applied | failed
  error_message TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(station_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS idx_station_sync_events_station ON station_sync_events(station_id, received_at);

-- Admin, bir yakit fiyatini ileri bir tarih/saatte otomatik devreye girecek sekilde
-- planlayabilir - bkz. scheduledPriceService.ts applyDuePriceChanges().
CREATE TABLE IF NOT EXISTS scheduled_price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  fuel_type TEXT NOT NULL,
  price_per_liter REAL NOT NULL,
  scheduled_for TEXT NOT NULL,          -- ISO tarih/saat - bu an gelince fiyat otomatik uygulanir
  status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | cancelled
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_price_changes_station ON scheduled_price_changes(station_id, status, scheduled_for);

-- Dayanikli (durable) yazma kuyrugu: Kafka/RabbitMQ'nun bu uygulamadaki islevsel
-- karsiligi - ek bir servis/maliyet gerektirmeden ayni SQLite veritabanini kullanir.
-- Bir isin "kabul edilmesi" (enqueueWrite - hizli, senkron INSERT) ile "islenmesi"
-- (processWriteQueue - arka planda, ör. e-posta/SMS gonderimi gibi yavas/agin
-- basarisiz olabilecek isler) birbirinden ayrilir: kayit ONCE buraya guvenle yazilir,
-- sunucu bu adimdan sonra coksede is asla sessizce kaybolmaz - bir sonraki
-- baslangicta islenmemis (processed_at IS NULL) kayittan kaldigi yerden devam eder.
-- Bkz. writeQueueService.ts.
CREATE TABLE IF NOT EXISTS write_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- ör. critical_alarm_notification
  payload TEXT NOT NULL,               -- JSON
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT                    -- NULL = henuz islenmedi/tekrar denenecek
);
CREATE INDEX IF NOT EXISTS idx_write_queue_pending ON write_queue(processed_at, id);

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
