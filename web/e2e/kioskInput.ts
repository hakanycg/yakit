import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Kiosk giriş alanları `readOnly`dir (bkz. web/src/kiosk/KioskKeyboard.tsx) - OS ekran
 * klavyesinin ve takılı fiziksel bir klavyenin devre dışı bırakılması BİLİNÇLİDİR
 * (kiosk kabuğundan kaçışı önlemek için). Değer yalnızca ekrandaki tuş takımına
 * TIKLANARAK değişir; bu yüzden e2e testleri de `fill()` yerine bu yardımcıyla
 * gerçek tıklamalar üretir.
 */
export async function typeViaKioskKeyboard(page: Page, input: Locator, text: string): Promise<void> {
  await input.click();
  const keyboard = page.locator(".kiosk-keyboard");
  await expect(keyboard).toBeVisible();
  for (const ch of text) {
    await keyboard.getByRole("button", { name: ch, exact: true }).click();
  }
  // Klavyeyi kapat (tuş takımı "dışına" tıklanınca da kapanır, bkz. KioskInput'taki
  // pointerdown dinleyicisi) - AÇIK BIRAKILIRSA, klavyenin kapanmasıyla oluşan ani
  // düzen (layout) kayması, hemen ardından TIKLANACAK bir sonraki butonun (ör. "Devam
  // Et") o anki sabit ekran koordinatını kaydırır ve tıklama BAŞKA bir öğeye gider -
  // Playwright hata vermez ama gerçek tıklama sessizce hedefini şaşırır.
  await keyboard.getByRole("button", { name: "Tamam" }).click();
}
