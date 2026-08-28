import { expect, test } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME, E2E_DEVICE_TOKEN, E2E_STATION_SLUG } from "./constants.js";
import { typeViaKioskKeyboard } from "./kioskInput.js";

/**
 * Yardim/destek cagrisi (bkz. gorev #115) kiosk'un HER adiminda erisilebilir - bu
 * yuzden musteri plaka/pompa/yakit akisinin hicbirinden gecmeden, karsilama
 * ekranindan dogrudan cagirabilir.
 *
 * Talebin sadece ekranda "gonderildi" gorunmesi yetmez - asil onemli olan sunucuya
 * GERCEKTEN ulasip kritik bir alarma donusmesidir (bkz. supportService.ts). Bu yuzden
 * test, UI'daki "gonderildi" ekranini gordukten SONRA, ayni testte bir admin oturumu
 * acip /api/support'tan talebin GERCEKTEN kaydedildigini ve bir alarm dogurdugunu
 * dogrular.
 */
test("kiosk: yardim cagrisi -> destek talebi olusur ve kritik alarma donusur", async ({ page, request }) => {
  // ?device=... zorunlu: /api/kiosk/support, istasyonun require_kiosk_token ayarindan
  // BAGIMSIZ olarak her zaman gecerli bir cihaz tokeni ister (bkz. server/src/routes/kiosk.ts -
  // "aksi halde bu uc, istasyon kimligini bilen herkesin nobetci personele SMS
  // yagdirabilecegi bir kanala donusurdu").
  await page.goto(`/kiosk/${E2E_STATION_SLUG}?device=${E2E_DEVICE_TOKEN}`);

  await page.getByRole("button", { name: "Yardım / Destek" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Varsayilan kategori zaten "Yakıt akmıyor / pompa çalışmıyor" (CATEGORIES[0]) - ayrica
  // secmeye gerek yok, ama testin gercekci olmasi icin acikca tiklaniyor.
  await page.getByRole("button", { name: "Yakıt akmıyor / pompa çalışmıyor" }).click();

  // Serbest metin alani da kiosk klavyesini kullanir (bkz. KioskKeyboard.tsx MESSAGE_ALPHABET).
  await typeViaKioskKeyboard(page, page.locator("#help-message"), "TEST");

  await page.getByRole("button", { name: "Talebi Gönder" }).click();

  await expect(page.getByRole("heading", { name: "Talebiniz iletildi" })).toBeVisible();

  // Sunucu tarafi dogrulama: admin oturumu acip talebin GERCEKTEN kaydedildigini ve
  // bir kritik alarma donustugunu (alarmId dolu) API'den kontrol et.
  const login = await request.post("/api/auth/login", {
    data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);

  const support = await request.get("/api/support?status=open");
  expect(support.ok()).toBe(true);
  const body = (await support.json()) as { requests: Array<{ category: string; message: string; alarmId: number | null }> };
  const created = body.requests.find((r) => r.message === "TEST");
  expect(created).toBeDefined();
  expect(created!.category).toBe("dispenser");
  // Talep kritik bir alarma donusmemis olsaydi (bkz. supportService.ts createSupportRequest)
  // nobetci personele HICBIR bildirim gitmezdi - bu, ozelligin butun amacini bosa cikarirdi.
  expect(created!.alarmId).not.toBeNull();
});
