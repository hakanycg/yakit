import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { StationRow, UserRow } from "../db/types.js";
import { createTestPump, createTestStation, createTestUser } from "../test/dbFixture.js";

// Gercek iyzico cagrisi test icinde disari cikamaz; yalnizca bu iki uc noktayi
// degistiriyoruz, modulun geri kalani gercek kalir (digerleri ayni modul grafigini
// paylasiyor - komple mock, ilgisiz servisleri de bozardi).
const refundPaymentMock = vi.fn();
const isIyzicoReadyMock = vi.fn((_stationId: number): { ready: boolean; reason?: string } => ({ ready: true }));

vi.mock("./iyzicoService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iyzicoService.js")>()),
  refundPayment: (...args: unknown[]) => refundPaymentMock(...args),
}));
vi.mock("./paymentSettingsService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paymentSettingsService.js")>()),
  isIyzicoReady: (stationId: number) => isIyzicoReadyMock(stationId),
}));

const { getRefundableInfo, listRefunds, refundTransaction, refundedTotal } = await import("./refundService.js");
const { adjustPoints, getBalance } = await import("./loyaltyService.js");
const { chargeAccount, createAccount, getAccountById } = await import("./fleetService.js");

let station: StationRow;
let pumpId: number;
let actor: UserRow;

interface SaleInput {
  amount: number;
  discount?: number;
  method?: string;
  paymentStatus?: string;
  reference?: string | null;
  points?: number;
  plate?: string;
}

function addSale(input: SaleInput): number {
  return db
    .prepare(
      `INSERT INTO transactions
         (station_id, pump_id, plate, fuel_type, amount_mode, price_per_liter, dispensed_liters,
          total_amount, discount_amount, loyalty_points_earned, payment_method, payment_status,
          payment_reference, status, kiosk_access_token)
       VALUES (?, ?, ?, 'motorin', 'amount', 45, 10, ?, ?, ?, ?, ?, ?, 'completed', ?)`
    )
    .run(
      station.id,
      pumpId,
      input.plate ?? "34ABC01",
      input.amount,
      input.discount ?? 0,
      input.points ?? 0,
      input.method ?? "iyzico",
      input.paymentStatus ?? "captured",
      input.reference === undefined ? "pay-ref-1" : input.reference,
      `tok-${Math.random().toString(16).slice(2)}`
    ).lastInsertRowid as number;
}

function paymentStatusOf(id: number): string {
  return db.prepare<[number], { payment_status: string }>("SELECT payment_status FROM transactions WHERE id = ?").get(id)!.payment_status;
}

beforeEach(() => {
  station = createTestStation();
  pumpId = createTestPump(station.id);
  actor = createTestUser(station.id, "admin");
  refundPaymentMock.mockReset();
  refundPaymentMock.mockResolvedValue({ refundId: "iyz-refund-1" });
  isIyzicoReadyMock.mockReset();
  isIyzicoReadyMock.mockReturnValue({ ready: true });
});

describe("getRefundableInfo", () => {
  it("iade edilebilir tutari TAHSIL EDILEN uzerinden hesaplar, brut uzerinden degil", () => {
    // Indirim/puan kullanimi musteriden hic tahsil edilmemistir; onu da iade etmek
    // musteriye hic odemedigi parayi geri vermek olurdu.
    const id = addSale({ amount: 1000, discount: 200 });

    const info = getRefundableInfo(station.id, id);
    expect(info.chargedAmount).toBe(800);
    expect(info.refundableAmount).toBe(800);
    expect(info.refundable).toBe(true);
  });

  it("tahsil edilmemis odemeyi iade edilebilir saymaz", () => {
    // Blokaj (authorized) icin iade degil IPTAL gerekir; para henuz cekilmemistir.
    const id = addSale({ amount: 500, paymentStatus: "authorized" });

    const info = getRefundableInfo(station.id, id);
    expect(info.refundable).toBe(false);
    expect(info.reason).toMatch(/tahsil edilmis/);
  });

  it("yapilan iadeler kadar kalan tutari azaltir", async () => {
    const id = addSale({ amount: 1000 });
    await refundTransaction(station.id, id, { amount: 300, reason: "Eksik yakit" }, actor);

    const info = getRefundableInfo(station.id, id);
    expect(info.refundedAmount).toBe(300);
    expect(info.refundableAmount).toBe(700);
  });

  it("baska istasyonun islemini bulunamadi sayar", () => {
    const other = createTestStation();
    const id = addSale({ amount: 500 });

    // Erisilemeyen ile var olmayan ayni cevabi dondurur: kayit sizdirmaz.
    expect(() => getRefundableInfo(other.id, id)).toThrow(/bulunamadi/);
    expect(() => getRefundableInfo(other.id, 999999)).toThrow(/bulunamadi/);
  });
});

describe("refundTransaction", () => {
  it("tutar verilmezse kalanin tamamini iade eder ve islemi iade edilmis isaretler", async () => {
    const id = addSale({ amount: 1000, discount: 100 });

    const refund = await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    expect(refund.amount).toBe(900);
    expect(refund.status).toBe("completed");
    expect(refund.provider_refund_id).toBe("iyz-refund-1");
    expect(paymentStatusOf(id)).toBe("refunded");
  });

  it("kismi iadede islem TAHSIL EDILMIS kalir", async () => {
    // Kismi iade edilmis bir islemi 'refunded' isaretlemek, kalan tutari da geri
    // gonderilmis gostermek olurdu; farki yalnizca refunds tablosu tasiyabilir.
    const id = addSale({ amount: 1000 });

    await refundTransaction(station.id, id, { amount: 250, reason: "Eksik yakit" }, actor);

    expect(paymentStatusOf(id)).toBe("captured");
    expect(refundedTotal(id)).toBe(250);
  });

  it("kismi iadeler birikerek tahsil edilen tutari asamaz", async () => {
    const id = addSale({ amount: 1000 });
    await refundTransaction(station.id, id, { amount: 600, reason: "Ilk" }, actor);
    await refundTransaction(station.id, id, { amount: 400, reason: "Ikinci" }, actor);

    expect(paymentStatusOf(id)).toBe("refunded");
    await expect(refundTransaction(station.id, id, { amount: 1, reason: "Ucuncu" }, actor)).rejects.toThrow(/zaten iade/);
  });

  it("tek seferde kalan tutardan fazlasini reddeder", async () => {
    const id = addSale({ amount: 1000 });
    await refundTransaction(station.id, id, { amount: 800, reason: "Ilk" }, actor);

    await expect(refundTransaction(station.id, id, { amount: 300, reason: "Fazla" }, actor)).rejects.toThrow(/asamaz/);
    expect(refundedTotal(id)).toBe(800);
  });

  it("tahsil edilmemis islemi iade etmeyi reddeder", async () => {
    const id = addSale({ amount: 500, paymentStatus: "authorized" });

    await expect(refundTransaction(station.id, id, { reason: "Deneme" }, actor)).rejects.toThrow(/tahsil edilmis/);
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("saglayici reddederse islemi DEGISTIRMEZ ama denemeyi kaydeder", async () => {
    // Para hala bizdedir: 'iade edildi' demek yanlis olurdu. Ama "iade denendi mi?"
    // sorusunun cevabi, musteri tekrar aradiginda aranan ilk seydir.
    const id = addSale({ amount: 1000 });
    refundPaymentMock.mockRejectedValue(new Error("iyzico iade islemi basarisiz."));

    await expect(refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor)).rejects.toThrow(/Iade yapilamadi/);

    expect(paymentStatusOf(id)).toBe("captured");
    expect(refundedTotal(id)).toBe(0);
    const rows = listRefunds(station.id, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toMatch(/basarisiz/);
    // Basarisiz deneme kalan tutari tuketmemeli: tekrar denenebilir olmali.
    expect(getRefundableInfo(station.id, id).refundableAmount).toBe(1000);
  });

  it("iyzico yapilandirilmamissa iade etmeye kalkismaz", async () => {
    const id = addSale({ amount: 500 });
    isIyzicoReadyMock.mockReturnValue({ ready: false, reason: "kapali" });

    await expect(refundTransaction(station.id, id, { reason: "Deneme" }, actor)).rejects.toThrow(/yapilandirilmamis/);
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("odeme referansi olmayan iyzico islemini reddeder", async () => {
    const id = addSale({ amount: 500, reference: null });

    await expect(refundTransaction(station.id, id, { reason: "Deneme" }, actor)).rejects.toThrow(/referansi yok/);
  });

  it("filo isleminde bakiyeyi hesaba geri yukler", async () => {
    const account = createAccount(station.id, { companyName: "Test Filo", billingType: "prepaid" }, actor);
    db.prepare("UPDATE fleet_accounts SET balance = 1000 WHERE id = ?").run(account.id);
    const id = addSale({ amount: 400, method: "fleet", reference: null });
    chargeAccount(station.id, account.id, 400, id);
    expect(getAccountById(station.id, account.id).balance).toBe(600);

    await refundTransaction(station.id, id, { amount: 150, reason: "Eksik yakit" }, actor);

    expect(getAccountById(station.id, account.id).balance).toBe(750);
    // Saglayici cagrisi yapilmamali: para karta degil hesaba doner.
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("filo tahsilat kaydi yoksa iade etmez", async () => {
    const id = addSale({ amount: 400, method: "fleet", reference: null });

    await expect(refundTransaction(station.id, id, { reason: "Deneme" }, actor)).rejects.toThrow(/tahsilat kaydi bulunamadi/);
  });

  it("iyzico disi yontemde saglayici cagrisi yapmadan kaydeder", async () => {
    const id = addSale({ amount: 300, method: "card", reference: null });

    const refund = await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    expect(refund.status).toBe("completed");
    expect(refund.provider_refund_id).toBeNull();
    expect(refundPaymentMock).not.toHaveBeenCalled();
  });

  it("gerekcesiz iadeyi reddeder", async () => {
    const id = addSale({ amount: 300 });

    await expect(refundTransaction(station.id, id, { reason: "   " }, actor)).rejects.toThrow(/gerekcesi/);
  });

  it("sifir veya negatif tutari reddeder", async () => {
    const id = addSale({ amount: 300 });

    await expect(refundTransaction(station.id, id, { amount: 0, reason: "Deneme" }, actor)).rejects.toThrow(/sifirdan buyuk/);
    await expect(refundTransaction(station.id, id, { amount: -5, reason: "Deneme" }, actor)).rejects.toThrow(/sifirdan buyuk/);
  });

  it("baska istasyonun islemini iade etmez", async () => {
    const other = createTestStation();
    const otherActor = createTestUser(other.id, "admin");
    const id = addSale({ amount: 500 });

    await expect(refundTransaction(other.id, id, { reason: "Deneme" }, otherActor)).rejects.toThrow(/bulunamadi/);
  });
});

describe("sadakat puani geri alma", () => {
  it("kismi iadede puani ORANTILI duser", async () => {
    const plate = "34PUAN01";
    const id = addSale({ amount: 1000, points: 100, plate });
    adjustPoints(station.id, plate, 100, "test", actor);

    await refundTransaction(station.id, id, { amount: 250, reason: "Eksik yakit" }, actor);

    expect(getBalance(station.id, plate)).toBe(75);
  });

  it("tam iadede kazanilan puanin tamamini geri alir", async () => {
    const plate = "34PUAN02";
    const id = addSale({ amount: 1000, points: 100, plate });
    adjustPoints(station.id, plate, 100, "test", actor);

    await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    expect(getBalance(station.id, plate)).toBe(0);
  });

  it("puan harcanmissa bakiyeyi eksiye dusurmez", async () => {
    // Eksiye dusurmek, musteriyi bir sonraki alisverisinde borclandirmak demek olurdu.
    const plate = "34PUAN03";
    const id = addSale({ amount: 1000, points: 100, plate });
    adjustPoints(station.id, plate, 30, "puanin bir kismi harcandi", actor);

    await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    expect(getBalance(station.id, plate)).toBe(0);
  });

  it("bakiye zaten sifirsa hic hareket yazmaz", async () => {
    // "25 puan geri alindi" diyen ama hicbir seyi degistirmeyen bir hareket, defteri
    // okuyani yanlis yonlendirir.
    const plate = "34PUAN05";
    const id = addSale({ amount: 1000, points: 100, plate });

    await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    const movements = db
      .prepare<[number, string], { count: number }>(
        "SELECT COUNT(*) AS count FROM loyalty_movements WHERE station_id = ? AND plate = ?"
      )
      .get(station.id, plate)!;
    expect(movements.count).toBe(0);
    expect(getBalance(station.id, plate)).toBe(0);
  });

  it("puan kazanilmamis islemde sadakat kaydina dokunmaz", async () => {
    const plate = "34PUAN04";
    const id = addSale({ amount: 1000, points: 0, plate });
    adjustPoints(station.id, plate, 50, "baska islemden", actor);

    await refundTransaction(station.id, id, { reason: "Musteri talebi" }, actor);

    expect(getBalance(station.id, plate)).toBe(50);
  });
});

describe("listRefunds", () => {
  it("yalnizca o islemin iadelerini, istasyon kapsaminda dondurur", async () => {
    const a = addSale({ amount: 500 });
    const b = addSale({ amount: 700 });
    await refundTransaction(station.id, a, { amount: 100, reason: "A iadesi" }, actor);
    await refundTransaction(station.id, b, { amount: 200, reason: "B iadesi" }, actor);

    const rows = listRefunds(station.id, a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
    expect(rows[0]!.username).toBe(actor.username);

    const other = createTestStation();
    expect(() => listRefunds(other.id, a)).toThrow(/bulunamadi/);
  });
});
