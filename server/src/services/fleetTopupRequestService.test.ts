import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { FleetAccountRow, FleetPortalUserRow, StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { createAccount } from "./fleetService.js";
import { createOrLinkPortalUser } from "./fleetPortalService.js";
import {
  TopupRequestError,
  approveRequest,
  cancelOwnRequest,
  createRequest,
  listPendingForStation,
  listRequestsForAccount,
  rejectRequest,
} from "./fleetTopupRequestService.js";

// Bildirim gonderimi bu testin konusu degil: SMTP/SMS yapilandirilmamis bir ortamda
// gercek gonderim denenirse test agdan bagimliligi tasir.
vi.mock("./notificationService.js", () => ({
  sendEmail: vi.fn(async () => {}),
  sendSms: vi.fn(async () => {}),
}));

let station: StationRow;
let staff: UserRow;
let account: FleetAccountRow;
let portalUser: FleetPortalUserRow;
let seq = 0;

function portalUserFor(accountId: number): FleetPortalUserRow {
  seq += 1;
  const email = `filo-topup-${Date.now()}-${seq}@ornek.com`;
  createOrLinkPortalUser(station.id, accountId, { email }, staff);
  return db.prepare<[string], FleetPortalUserRow>("SELECT * FROM fleet_portal_users WHERE email = ?").get(email)!;
}

beforeEach(() => {
  station = createTestStation();
  staff = createTestUser(station.id, "admin");
  account = createAccount(station.id, { companyName: "Talep Lojistik", billingType: "prepaid" }, staff);
  portalUser = portalUserFor(account.id);
});

describe("filo bakiye yukleme talebi", () => {
  it("talep acmak bakiyeyi DEGISTIRMEZ - para tasimaz, mesaj tasir", () => {
    createRequest(account, portalUser, 5000, "havale bugun yapildi");
    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(0);
  });

  it("ayni hesapta ikinci bir acik talep acilamaz", () => {
    createRequest(account, portalUser, 1000, undefined);
    expect(() => createRequest(account, portalUser, 2000, undefined)).toThrow(TopupRequestError);
  });

  it("musteri kendi bekleyen talebini geri cekince yenisini acabilir", () => {
    const first = createRequest(account, portalUser, 1000, undefined);
    cancelOwnRequest(first.id, account.id);
    expect(listPendingForStation(station.id)).toHaveLength(0);
    expect(() => createRequest(account, portalUser, 2000, undefined)).not.toThrow();
  });

  it("baska bir hesabin talebi geri cekilemez", () => {
    const other = createAccount(station.id, { companyName: "Baska A.S.", billingType: "prepaid" }, staff);
    const request = createRequest(account, portalUser, 1000, undefined);
    expect(() => cancelOwnRequest(request.id, other.id)).toThrow(TopupRequestError);
  });

  it("bakiyeye TALEP EDILEN degil, personelin tahsil ettigi tutar yazilir", () => {
    const request = createRequest(account, portalUser, 5000, undefined);
    // Musteri 5.000 yazdi ama kasaya 4.800 girdi.
    const { account: updated } = approveRequest(request.id, station.id, staff, { amount: 4800 });
    expect(updated.balance).toBe(4800);
    expect(listRequestsForAccount(account.id)[0]!.approved_amount).toBe(4800);
  });

  it("ayni talep iki kez onaylanamaz - bakiye iki kez artmaz", () => {
    const request = createRequest(account, portalUser, 1000, undefined);
    approveRequest(request.id, station.id, staff, { amount: 1000 });
    expect(() => approveRequest(request.id, station.id, staff, { amount: 1000 })).toThrow(TopupRequestError);
    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(1000);
  });

  it("baska istasyonun personeli talebi sonuclandiramaz", () => {
    const request = createRequest(account, portalUser, 1000, undefined);
    const foreign = createTestStation();
    expect(() => approveRequest(request.id, foreign.id, staff, { amount: 1000 })).toThrow(TopupRequestError);
  });

  it("reddedilen talep bakiyeyi degistirmez ve listeden duser", () => {
    const request = createRequest(account, portalUser, 1000, undefined);
    const rejected = rejectRequest(request.id, station.id, staff, "dekont gelmedi");
    expect(rejected.status).toBe("rejected");
    expect(rejected.approved_amount).toBeNull();
    const after = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(account.id)!;
    expect(after.balance).toBe(0);
    expect(listPendingForStation(station.id)).toHaveLength(0);
  });

  it("sifir ya da negatif tutarli talep kabul edilmez", () => {
    expect(() => createRequest(account, portalUser, 0, undefined)).toThrow(TopupRequestError);
    expect(() => createRequest(account, portalUser, -100, undefined)).toThrow(TopupRequestError);
  });
});
