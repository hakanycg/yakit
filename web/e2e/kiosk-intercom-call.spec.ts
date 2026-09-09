import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_DEVICE_TOKEN,
  E2E_PORT,
  E2E_STATION_SLUG,
} from "./constants.js";

const baseURL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Iki yonlu sesli interkom (bkz. gorev #187-191, TS 12820 madde 4.9.3.5): musteri
 * kiosk'tan gorevliyi arayabilmeli, gorevli (hangi panel sayfasinda olursa olsun)
 * gelen cagriyi gorup yanitlayabilmeli ve WebRTC baglantisi GERCEKTEN kurulmali.
 *
 * Bu test iki ayri tarayici baglamiyla (kiosk + operator) sinyallesme kanalinin
 * ucdan uca calistigini dogrular: kiosk aramayi baslatir, operator ekraninda
 * gelen cagri bildirimi belirir, "Yanitla"ya basilinca HER IKI tarafta da
 * "Baglandi" durumuna gecilir (RTCPeerConnection gercekten "connected" olur -
 * sahte mikrofon cihazi bayraklariyla, bkz. playwright.config.ts). Gercek ses
 * verisinin dogrulugu kapsam disi; SDP/ICE degisiminin basariyla sonuclandigi
 * (baglanti durumu) dogrulanir.
 */
test("interkom: kiosk gorevliyi arar, operator yanitlar, iki tarafta da baglanti kurulur", async ({ page, browser }) => {
  await page.context().grantPermissions(["microphone"], { origin: baseURL });

  const operatorContext = await browser.newContext();
  await operatorContext.grantPermissions(["microphone"], { origin: baseURL });
  const operatorPage = await operatorContext.newPage();

  try {
    // Operator once giris yapip panelde (herhangi bir sayfada) olsun - AppLayout
    // icine gomulu IncomingIntercomCall, hangi sayfada olursa olsun cagriyi yakalar.
    await operatorPage.goto("/giris");
    await operatorPage.getByLabel("Kullanıcı adı").fill(E2E_ADMIN_USERNAME);
    await operatorPage.getByLabel("Şifre").fill(E2E_ADMIN_PASSWORD);
    await operatorPage.getByRole("button", { name: "Giriş Yap" }).click();
    // E2E admin kullanicisi "admin" rolunde - basarili giris sonrasi /admin'e
    // yonlendirilir (bkz. Login.tsx); AppLayout (ve icindeki IncomingIntercomCall)
    // her iki rota grubunda da AYNI kabuk oldugundan, cagriyi yakalamak icin
    // acikca /operator'a gecilir.
    await expect(operatorPage).toHaveURL(/\/admin/);
    await operatorPage.goto("/operator");

    // Musteri kiosk'tan gorevliyi arar.
    await page.goto(`/kiosk/${E2E_STATION_SLUG}?device=${E2E_DEVICE_TOKEN}`);
    await page.getByRole("button", { name: "Görevliyi Ara" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Aramayı Başlat" }).click();

    // Operator ekraninda gelen cagri bildirimi belirmeli (kiosk'un konumu/pompasindan
    // BAGIMSIZ olarak, sunucunun broadcast() ettigi "intercom-calls:<stationId>"
    // topic'i uzerinden - bkz. routes/kiosk.ts POST /intercom/ring).
    await expect(operatorPage.getByRole("heading", { name: "İnterkom Çağrısı" })).toBeVisible({ timeout: 15_000 });
    await operatorPage.getByRole("button", { name: "Yanıtla" }).click();

    // Her iki tarafta da RTCPeerConnection GERCEKTEN "connected" durumuna gecmeli -
    // yalnizca sinyallesme mesajlarinin degil, gercek SDP/ICE muzakeresinin de
    // basarili oldugunun kaniti (bkz. useIntercomCall.ts onconnectionstatechange).
    await expect(page.getByText("Bağlandı — konuşabilirsiniz")).toBeVisible({ timeout: 20_000 });
    await expect(operatorPage.getByText("Bağlandı — konuşabilirsiniz")).toBeVisible({ timeout: 20_000 });

    // Operator gorusmeyi bitirince kiosk tarafi da (hangup sinyaliyle) sonlanmali.
    await operatorPage.getByRole("button", { name: "Görüşmeyi Bitir" }).click();
    await expect(page.getByText("Görüşme sona erdi")).toBeVisible({ timeout: 10_000 });
  } finally {
    await operatorContext.close();
  }
});
