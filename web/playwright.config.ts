import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./e2e/constants.js";

const baseURL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Kiosk akışı için uçtan uca (gerçek tarayıcı) testler.
 *
 * Sunucu, üretim modunda (NODE_ENV=production) web/dist'i kendi içinden statik olarak
 * servis eder (bkz. server/src/app.ts) - ayrı bir `vite preview` sunucusuna ve
 * dolayısıyla CORS/cookie-domain karmaşasına gerek yok.
 *
 * Sunucu Playwright'in kendi `webServer` eklentisiyle DEĞİL, globalSetup.ts'te ELLE
 * başlatılır (ve globalTeardown.ts'te kapatılır) - `webServer` eklentisinin
 * globalSetup ile çalışma SIRASININ garanti olmaması, sunucunun tohumlama
 * TAMAMLANMADAN önce boş bir veritabanı dosyasını açıp bağlantıyı açık tutmasına yol
 * açabiliyordu (bkz. globalSetup.ts'teki ayrıntılı not).
 *
 * Kapsam BİLEREK SINIRLI: iyzico ve Uyumsoft akışları bu sandbox'ta zaten canlı test
 * EDİLEMİYOR (README'de belgeli - dışa giden ağ erişimi yok). Bu testler o kısıtı
 * GENİŞLETMEZ, yalnızca tamamen iç/deterministik yolları (filo ödemesi, yardım çağrısı)
 * kapsar.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup.ts",
  globalTeardown: "./e2e/globalTeardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Bu ortamda Chromium onceden kurulu (bkz. PLAYWRIGHT_BROWSERS_PATH); `@playwright/test`
    // surumu paketle gelen surumden farkli olabileceginden, indirmeye calismak yerine
    // dogrudan onceden kurulu ikiliyi kullanir. CI'da (bkz. .github/workflows/ci.yml,
    // `playwright install --with-deps chromium`) bu yol yoktur - o zaman Playwright kendi
    // indirdigi surumu kullanir; PLAYWRIGHT_BROWSERS_PATH tanimli degilse bu satir no-op'tur.
    launchOptions: process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: "/opt/pw-browsers/chromium" } : {},
  },
});
