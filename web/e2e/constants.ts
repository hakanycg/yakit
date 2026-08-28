/**
 * e2e testlerinin ve sunucu tarafi tohumlama betiğinin (server/src/scripts/seedE2E.ts)
 * PAYLAŞTIĞI sabitler.
 *
 * İki ayrı workspace (web/server) olduğu için bir TS modülü doğrudan paylaşılamaz - bu
 * yüzden değerler burada TEK yerde tanımlanır ve globalSetup.ts, tohumlama betiğine bunları
 * ortam değişkeni olarak GEÇİRİR (aynı string'i iki dosyada elle tekrarlamak, biri
 * değişince diğerinin sessizce eskimesine yol açardı).
 */

export const E2E_DATABASE_PATH = "./data/e2e.sqlite";
export const E2E_SESSION_SECRET = "e2e-test-session-secret-0000000000000000000000";
export const E2E_PORT = 4310;

export const E2E_STATION_SLUG = "e2e-istasyon";
export const E2E_STATION_NAME = "E2E Test İstasyonu";
export const E2E_CONTACT_PHONE = "+90 500 000 00 00";
export const E2E_PUMP_LABEL = "Pompa 1";
/** Kiosk cihaz tokeni (bkz. kioskDeviceToken.ts) - /api/kiosk/heartbeat ve /api/kiosk/support
 * UCU, istasyonun require_kiosk_token ayarindan BAGIMSIZ olarak bunu HER ZAMAN ister
 * (bkz. server/src/routes/kiosk.ts) - bu yuzden e2e testleri de gercek bir kiosk kurulumu
 * gibi `/kiosk/<slug>?device=<token>` adresini kullanir. */
export const E2E_DEVICE_TOKEN = "e2e-device-token-0000000000000000";
export const E2E_FUEL_TYPE = "motorin";
/** Yüksek tutulur: küçük bir TL tutarı (bkz. E2E_AMOUNT_TL) az litreye denk gelsin ki
 * simüle edilen dolum (bkz. dispenserDriver.ts, ~0.45-0.75 L/sn) testte saniyeler içinde bitsin. */
export const E2E_PRICE_PER_LITER = 100;
/** Kiosk'taki sabit hızlı tutar seçeneklerinden biri (bkz. AmountStep.tsx QUICK_AMOUNTS). */
export const E2E_AMOUNT_TL = 200;

export const E2E_PLATE = "34TEST01";
export const E2E_FLEET_COMPANY = "E2E Filo A.Ş.";
export const E2E_FLEET_BALANCE = 5000;

export const E2E_ADMIN_USERNAME = "e2e-admin";
export const E2E_ADMIN_PASSWORD = "E2eTestSifre!2026";
