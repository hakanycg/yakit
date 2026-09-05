import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { FleetAccountRow, FleetPortalUserRow, StationRow, UserRow } from "../db/types.js";
import { env } from "../config.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { createAccount } from "./fleetService.js";
import { createOrLinkPortalUser } from "./fleetPortalService.js";
import { setFleetCardTopupConfig } from "./paymentSettingsService.js";

// Gercek iyzico cagrisi test icinde disari cikamaz; yalnizca bu iki uc noktayi
// degistiriyoruz (aynen refundService.test.ts'teki desen) - modulun geri kalani
// gercek kalir.
const initializeFleetTopupCheckoutFormMock = vi.fn();
const retrieveCheckoutFormMock = vi.fn();

vi.mock("./iyzicoService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iyzicoService.js")>()),
  initializeFleetTopupCheckoutForm: (...args: unknown[]) => initializeFleetTopupCheckoutFormMock(...args),
  retrieveCheckoutForm: (...args: unknown[]) => retrieveCheckoutFormMock(...args),
}));

const {
  FleetCardTopupError,
  finalizeCardTopup,
  getTopupOrThrow,
  listTopupsForAccount,
  startCardTopup,
} = await import("./fleetCardTopupService.js");
const { IyzicoError } = await import("./iyzicoService.js");

let station: StationRow;
let staff: UserRow;
let account: FleetAccountRow;
let portalUser: FleetPortalUserRow;
let seq = 0;
let previousPublicApiBaseUrl: string | undefined;

function portalUserFor(accountId: number): FleetPortalUserRow {
  seq += 1;
  const email = `filo-kart-${Date.now()}-${seq}@ornek.com`;
  createOrLinkPortalUser(station.id, accountId, { email }, staff);
  return db.prepare<[string], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE email = ?").get(email)!;
}

beforeEach(() => {
  previousPublicApiBaseUrl = env.PUBLIC_API_BASE_URL;
  env.PUBLIC_API_BASE_URL = "https://ops.example.com";

  station = createTestStation();
  staff = createTestUser(station.id, "admin");
  account = createAccount(station.id, { companyName: "Kart Lojistik", billingType: "prepaid" }, staff);
  portalUser = portalUserFor(account.id);
  setFleetCardTopupConfig(station.id, { enabled: true, feePct: 3 }, staff);

  initializeFleetTopupCheckoutFormMock.mockReset();
  retrieveCheckoutFormMock.mockReset();
  initializeFleetTopupCheckoutFormMock.mockImplementation(async () => ({
    token: "test-token",
    checkoutFormContent: "<div>form</div>",
    paymentPageUrl: null,
  }));
});

afterEach(() => {
  env.PUBLIC_API_BASE_URL = previousPublicApiBaseUrl;
});

describe("filo portali kartla anlik yukleme", () => {
  it("baslatma bakiyeye DOKUNMAZ - kayit 'pending' acilir, para henuz tasinmaz", async () => {
    const result = await startCardTopup(account, portalUser, 1000, "127.0.0.1");
    expect(result.requestedAmount).toBe(1000);
    expect(result.feeAmount).toBe(30);
    expect(result.grossAmount).toBe(1030);

    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(0);

    const row = getTopupOrThrow(result.topupId);
    expect(row.status).toBe("pending");
    expect(row.iyzico_token).toBe("test-token");
  });

  it("kanal kapaliyken baslatilamaz", async () => {
    setFleetCardTopupConfig(station.id, { enabled: false }, staff);
    await expect(startCardTopup(account, portalUser, 1000, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);
  });

  it("PUBLIC_API_BASE_URL tanimsizsa baslatilamaz", async () => {
    env.PUBLIC_API_BASE_URL = undefined;
    await expect(startCardTopup(account, portalUser, 1000, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);
  });

  it("sifir ya da negatif tutar reddedilir", async () => {
    await expect(startCardTopup(account, portalUser, 0, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);
    await expect(startCardTopup(account, portalUser, -50, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);
  });

  it("pasif hesapta baslatilamaz", async () => {
    db.prepare("UPDATE fleet_accounts SET active = 0 WHERE id = ?").run(account.id);
    const inactive = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    await expect(startCardTopup(inactive, portalUser, 1000, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);
  });

  it("iyzico baslatmasi basarisiz olursa kayit 'failed' isaretlenir, 'pending' takilip kalmaz", async () => {
    initializeFleetTopupCheckoutFormMock.mockRejectedValueOnce(new IyzicoError("iyzico hata", 502));
    await expect(startCardTopup(account, portalUser, 1000, "127.0.0.1")).rejects.toThrow(FleetCardTopupError);

    const rows = listTopupsForAccount(account.id);
    expect(rows[0]!.status).toBe("failed");
  });

  it("yanlis token ile finalize edilemez (403)", async () => {
    const result = await startCardTopup(account, portalUser, 1000, "127.0.0.1");
    await expect(finalizeCardTopup(result.topupId, "yanlis-token")).rejects.toThrow(FleetCardTopupError);

    const row = getTopupOrThrow(result.topupId);
    expect(row.status).toBe("pending");
  });

  it("basarili odeme sonucunda NET tutar (hizmet bedeli HARIC) hesaba islenir", async () => {
    const result = await startCardTopup(account, portalUser, 2000, "127.0.0.1");
    retrieveCheckoutFormMock.mockResolvedValueOnce({
      success: true,
      conversationId: String(result.topupId),
      paymentId: "pay-1",
      paidPrice: result.grossAmount,
      message: "ok",
    });

    const outcome = await finalizeCardTopup(result.topupId, "test-token");
    expect(outcome.success).toBe(true);

    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    // 2000 talep edildi, %3 (60) hizmet bedeli - hesaba yalnizca 2000 (net) islenir.
    expect(after.balance).toBe(2000);

    const row = getTopupOrThrow(result.topupId);
    expect(row.status).toBe("paid");
    expect(row.payment_reference).toBe("pay-1");
  });

  it("basarisiz odeme bakiyeyi etkilemez, kayit 'failed' olur", async () => {
    const result = await startCardTopup(account, portalUser, 1000, "127.0.0.1");
    retrieveCheckoutFormMock.mockResolvedValueOnce({
      success: false,
      conversationId: String(result.topupId),
      paymentId: null,
      paidPrice: null,
      message: "kart reddedildi",
    });

    const outcome = await finalizeCardTopup(result.topupId, "test-token");
    expect(outcome.success).toBe(false);

    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(0);
    expect(getTopupOrThrow(result.topupId).status).toBe("failed");
  });

  it("finalize idempotent'tir: ikinci cagri bakiyeyi tekrar artirmaz", async () => {
    const result = await startCardTopup(account, portalUser, 1000, "127.0.0.1");
    retrieveCheckoutFormMock.mockResolvedValue({
      success: true,
      conversationId: String(result.topupId),
      paymentId: "pay-1",
      paidPrice: result.grossAmount,
      message: "ok",
    });

    await finalizeCardTopup(result.topupId, "test-token");
    const second = await finalizeCardTopup(result.topupId, "test-token");
    expect(second.success).toBe(true);

    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(1000);
    expect(retrieveCheckoutFormMock).toHaveBeenCalledTimes(1);
  });

  it("conversationId uyusmazsa reddedilir", async () => {
    const result = await startCardTopup(account, portalUser, 1000, "127.0.0.1");
    retrieveCheckoutFormMock.mockResolvedValueOnce({
      success: true,
      conversationId: "999999",
      paymentId: "pay-1",
      paidPrice: result.grossAmount,
      message: "ok",
    });

    await expect(finalizeCardTopup(result.topupId, "test-token")).rejects.toThrow(FleetCardTopupError);
    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(0);
  });
});
