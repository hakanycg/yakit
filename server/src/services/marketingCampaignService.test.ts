import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { setMarketingConsent } from "./loyaltyService.js";
import type { StationRow, UserRow } from "../db/types.js";

const sendEmailMock = vi.hoisted(() => vi.fn(async (_to: string) => ({ sent: true })));
const sendSmsMock = vi.hoisted(() => vi.fn(async (_to: string) => ({ sent: true })));
vi.mock("./notificationService.js", () => ({
  sendEmail: sendEmailMock,
  sendSms: sendSmsMock,
}));

const { MarketingCampaignError, createAndSendCampaign, listCampaigns, previewSegment } = await import("./marketingCampaignService.js");

let station: StationRow;
let actor: UserRow;

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
  sendEmailMock.mockClear();
  sendSmsMock.mockClear();
  sendEmailMock.mockResolvedValue({ sent: true });
  sendSmsMock.mockResolvedValue({ sent: true });
});

describe("previewSegment", () => {
  it("yalnizca rizasi olan VE ilgili kanalda iletisim adresi olan plakalari sayar", () => {
    setMarketingConsent(station.id, "34ABC01", true, "musteri1@example.com", null);
    setMarketingConsent(station.id, "34ABC02", false, "musteri2@example.com", null); // riza yok
    setMarketingConsent(station.id, "34ABC03", true, null, "+905551234567"); // e-posta yok, SMS icin uygun

    expect(previewSegment(station.id, "email", {})).toBe(1);
    expect(previewSegment(station.id, "sms", {})).toBe(1);
  });

  it("baska istasyonun rizali musterilerini saymaz", () => {
    const other = createTestStation();
    setMarketingConsent(other.id, "34ABC01", true, "musteri@example.com", null);

    expect(previewSegment(station.id, "email", {})).toBe(0);
  });

  it("minDaysSinceVisit ile yalnizca uzun suredir gelmeyenleri sayar", () => {
    setMarketingConsent(station.id, "34ABC01", true, "yeni@example.com", null);
    setMarketingConsent(station.id, "34ABC02", true, "eski@example.com", null);
    // Eski ziyareti simule etmek icin updated_at'i elle 60 gun geriye cek.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE loyalty_accounts SET updated_at = ? WHERE station_id = ? AND plate = ?").run(sixtyDaysAgo, station.id, "34ABC02");

    // "en az 30 gundur gelmeyenler": yalnizca eski@ uyar.
    expect(previewSegment(station.id, "email", { minDaysSinceVisit: 30 })).toBe(1);
    // "son 30 gunde gelenler": yalnizca yeni@ uyar.
    expect(previewSegment(station.id, "email", { maxDaysSinceVisit: 30 })).toBe(1);
  });
});

describe("createAndSendCampaign", () => {
  it("bos segmentte hata firlatir, hicbir e-posta/SMS gondermez", async () => {
    await expect(createAndSendCampaign(station.id, { name: "Test", channel: "email", message: "Merhaba" }, actor)).rejects.toThrow(
      MarketingCampaignError
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rizali musterilere e-posta gonderir, kampanya kaydini dogru sayaclarla olusturur", async () => {
    setMarketingConsent(station.id, "34ABC01", true, "musteri1@example.com", null);
    setMarketingConsent(station.id, "34ABC02", true, "musteri2@example.com", null);

    const campaign = await createAndSendCampaign(station.id, { name: "Yaz Kampanyasi", channel: "email", message: "Indirim var!" }, actor);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(campaign.recipient_count).toBe(2);
    expect(campaign.success_count).toBe(2);
    expect(campaign.sent_at).not.toBeNull();
  });

  it("gonderim kismen basarisiz olursa success_count buna gore dusuk kalir", async () => {
    setMarketingConsent(station.id, "34ABC01", true, "basarili@example.com", null);
    setMarketingConsent(station.id, "34ABC02", true, "basarisiz@example.com", null);
    sendEmailMock.mockImplementation(async (to: string) => ({ sent: to === "basarili@example.com" }));

    const campaign = await createAndSendCampaign(station.id, { name: "Test", channel: "email", message: "Merhaba" }, actor);

    expect(campaign.recipient_count).toBe(2);
    expect(campaign.success_count).toBe(1);
  });

  it("riza vermemis (marketing_consent=false) musteriye GONDERMEZ", async () => {
    setMarketingConsent(station.id, "34ABC01", false, "riza-yok@example.com", null);

    await expect(createAndSendCampaign(station.id, { name: "Test", channel: "email", message: "Merhaba" }, actor)).rejects.toThrow(
      MarketingCampaignError
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("SMS kanalinda sendSms kullanir, e-postasi olup telefonu olmayan musteriyi atlar", async () => {
    setMarketingConsent(station.id, "34ABC01", true, "sadece-eposta@example.com", null);
    setMarketingConsent(station.id, "34ABC02", true, null, "+905551234567");

    const campaign = await createAndSendCampaign(station.id, { name: "SMS Kampanyasi", channel: "sms", message: "Firsat!" }, actor);

    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).toHaveBeenCalledWith("+905551234567", "Firsat!");
    expect(campaign.recipient_count).toBe(1);
  });

  it("bos ad/mesaj reddedilir", async () => {
    setMarketingConsent(station.id, "34ABC01", true, "x@example.com", null);
    await expect(createAndSendCampaign(station.id, { name: "  ", channel: "email", message: "Merhaba" }, actor)).rejects.toThrow(
      MarketingCampaignError
    );
    await expect(createAndSendCampaign(station.id, { name: "Test", channel: "email", message: "   " }, actor)).rejects.toThrow(
      MarketingCampaignError
    );
  });
});

describe("listCampaigns", () => {
  it("istasyona gore filtreler ve toplam sayiyi doner", async () => {
    setMarketingConsent(station.id, "34ABC01", true, "a@example.com", null);
    await createAndSendCampaign(station.id, { name: "Kampanya 1", channel: "email", message: "Merhaba" }, actor);

    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    setMarketingConsent(other.id, "34XYZ01", true, "b@example.com", null);
    await createAndSendCampaign(other.id, { name: "Baska Istasyon Kampanyasi", channel: "email", message: "Merhaba" }, otherActor);

    const { campaigns, total } = listCampaigns(station.id, 50, 0);
    expect(total).toBe(1);
    expect(campaigns[0]!.name).toBe("Kampanya 1");
  });
});
