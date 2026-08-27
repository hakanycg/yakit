import { expect, test } from "@playwright/test";
import { E2E_AMOUNT_TL, E2E_DEVICE_TOKEN, E2E_FLEET_COMPANY, E2E_PLATE, E2E_PUMP_LABEL, E2E_STATION_SLUG } from "./constants.js";
import { typeViaKioskKeyboard } from "./kioskInput.js";

/**
 * Uctan uca (gercek tarayici + gercek sunucu + gercek SQLite) filo odemesi akisi.
 *
 * iyzico'ya HIC uğramaz - bu istasyonda iyzico yapilandirilmadigi icin (bkz. seedE2E.ts)
 * FleetChoicePanel'e dusen tek yol filo hesabidir; bu, iyzico/Uyumsoft'un bu sandbox'ta
 * zaten canli test edilemedigi kisitla CELISMEZ (bkz. playwright.config.ts basindaki not).
 */
test("kiosk: plaka -> pompa -> yakit -> tutar -> filo hesabiyla odeme -> makbuz", async ({ page }) => {
  // Gercek bir termal yazici/ajan bu ortamda yok; ReceiptStep'in yedek window.print()
  // cagrisi gorunur bir dialog acmasin diye no-op'a alinir (bkz. localAgentPrint.ts -
  // ajana 1.2sn zaman asimiyla ulasilamayinca otomatik olarak buraya duser).
  await page.addInitScript(() => {
    window.print = () => {};
  });

  // ?device=... : gercek bir kiosk kurulumunun ilk acilisiyla AYNI (bkz. kioskDeviceToken.ts) -
  // /api/kiosk/heartbeat gibi uclar istasyonun require_kiosk_token ayarindan BAGIMSIZ
  // olarak her zaman gecerli bir cihaz tokeni ister (bkz. server/src/routes/kiosk.ts).
  await page.goto(`/kiosk/${E2E_STATION_SLUG}?device=${E2E_DEVICE_TOKEN}`);

  // Karsilama: varsayilan dil Turkce (bkz. i18n.tsx STORAGE_KEY yoksa "tr").
  await page.getByRole("button", { name: "Devam Et" }).click();

  // Plaka: klavye readOnly oldugu icin ekran tus takimina tiklanarak yazilir.
  await typeViaKioskKeyboard(page, page.locator(".kiosk-input-wrap input"), E2E_PLATE);
  await page.getByRole("button", { name: "Devam Et" }).click();

  // Pompa secimi.
  await page.getByRole("button", { name: new RegExp(E2E_PUMP_LABEL) }).click();

  // Yakit secimi.
  await page.getByRole("button", { name: "Motorin" }).click();

  // Tutar: sabit hizli tutar butonlarindan biri (bkz. AmountStep.tsx QUICK_AMOUNTS).
  await page.getByRole("button", { name: new RegExp(String(E2E_AMOUNT_TL)) }).click();
  await page.getByRole("button", { name: "Devam Et" }).click();

  // Odeme: plaka aktif bir filo hesabina bagli oldugu icin (bkz. seedE2E.ts) kiosk
  // otomatik olarak FleetChoicePanel'i gosterir - iyzico'ya hic ugramaz.
  await expect(page.getByRole("heading", { name: "Filo Hesabı ile Ödeme" })).toBeVisible();
  await expect(page.getByText(E2E_FLEET_COMPANY)).toBeVisible();
  await page.getByRole("button", { name: "Filo Hesabı ile Öde" }).click();

  // Dolum sunucu tarafinda gercekten simule edilir (bkz. dispenserDriver.ts); e2e fiyati
  // (E2E_PRICE_PER_LITER) kasten yuksek tutuldu ki litre az olsun, dolum saniyeler icinde
  // bitsin - bu yuzden burada sahte bir zamanlayici veya mock YOK, gercek WS guncellemesi
  // beklenir.
  await expect(page.getByRole("heading", { name: "İşlem Tamamlandı" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(E2E_PLATE)).toBeVisible();
});
