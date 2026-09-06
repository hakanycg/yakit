import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import type { FuelStockMovementRow, StationRow, UserRow } from "../db/types.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { addStock } from "./fuelStockService.js";
import { setInvoiceConfig } from "./invoiceSettingsService.js";
import { createWaybill, WaybillError } from "./waybillService.js";

let station: StationRow;
let actor: UserRow;

function configureProvider(): void {
  setInvoiceConfig(
    station.id,
    { enabled: true, environment: "sandbox", username: "kullanici", password: "sifre", companyVkn: "1234567890", companyTitle: "Test Akaryakit A.S." },
    actor
  );
}

function deliveryMovement(liters = 1000): FuelStockMovementRow {
  addStock(station.id, "benzin", liters, { supplier: "Test Tedarikci", deliveryRef: `IRS-${Math.random()}` }, actor);
  return db.prepare<[], FuelStockMovementRow>("SELECT * FROM fuel_stock_movements ORDER BY id DESC LIMIT 1").get()!;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "super_admin");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWaybill", () => {
  it("saglayici baglanmamis istasyonda hic fetch cagirmadan hata firlatir", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createWaybill(deliveryMovement())).rejects.toThrow(WaybillError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("teslimat disi (sale/adjustment) bir hareket icin irsaliye kesmez", async () => {
    configureProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const movement = deliveryMovement();
    await expect(createWaybill({ ...movement, type: "adjustment" })).rejects.toThrow(
      "Yalnizca teslimat hareketleri icin irsaliye kesilebilir."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("basarili yanitta saglayicinin dondurdugu irsaliye kimligini dondurur", async () => {
    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Success: true, DespatchId: "IRS-1" }) }) as unknown as Response)
    );

    const result = await createWaybill(deliveryMovement());
    expect(result.providerWaybillId).toBe("IRS-1");
  });

  it("teslim alinan miktari (liters) DespatchLine'a dogru yazar", async () => {
    configureProvider();
    let sentBody: { DespatchAdvice: { DespatchLine: [{ DeliveredQuantity: number }] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => ({ Success: true, DespatchId: "IRS-1" }) } as unknown as Response;
      })
    );

    await createWaybill(deliveryMovement(1234.5));
    expect(sentBody!.DespatchAdvice.DespatchLine[0].DeliveredQuantity).toBe(1234.5);
  });

  it("saglayiciya baglanti kurulamazsa 502 WaybillError firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const err = await createWaybill(deliveryMovement()).catch((e) => e);
    expect(err).toBeInstanceOf(WaybillError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("saglayici HTTP hatasi dondururse status kodunu iceren bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => null }) as unknown as Response));

    const err = await createWaybill(deliveryMovement()).catch((e) => e);
    expect(err).toBeInstanceOf(WaybillError);
    expect(err.message).toContain("500");
  });

  it("saglayici Success:false donerse ErrorMessage'i yansitan bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Success: false, ErrorMessage: "gecersiz istek" }) }) as unknown as Response)
    );

    await expect(createWaybill(deliveryMovement())).rejects.toThrow("gecersiz istek");
  });

  it("saglayici gecersiz/bos yanit donerse genel bir hata firlatir", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => null }) as unknown as Response));

    await expect(createWaybill(deliveryMovement())).rejects.toThrow(WaybillError);
  });
});
