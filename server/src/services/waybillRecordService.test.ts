import { beforeEach, describe, expect, it } from "vitest";
import type { StationRow, UserRow } from "../db/types.js";
import { addStock } from "./fuelStockService.js";
import { createTestStation, createTestUser } from "../test/dbFixture.js";
import { db } from "../db/index.js";
import { getWaybillForMovement, recordWaybillFailure, recordWaybillSuccess, serializeWaybill } from "./waybillRecordService.js";

let station: StationRow;
let actor: UserRow;

function createTestMovementId(): number {
  addStock(station.id, "benzin", 1000, { supplier: "Test Tedarikci" }, actor);
  return db.prepare<[], { id: number }>("SELECT id FROM fuel_stock_movements ORDER BY id DESC LIMIT 1").get()!.id;
}

beforeEach(() => {
  station = createTestStation();
  actor = createTestUser(station.id, "admin");
});

describe("getWaybillForMovement", () => {
  it("hic irsaliye kesilmemis bir hareket icin undefined doner", () => {
    expect(getWaybillForMovement(createTestMovementId())).toBeUndefined();
  });
});

describe("recordWaybillSuccess", () => {
  it("basarili irsaliyeyi 'sent' statusuyle kaydeder", () => {
    const movementId = createTestMovementId();
    const waybill = recordWaybillSuccess(station.id, movementId, "IRS-1", actor);
    expect(waybill.status).toBe("sent");
    expect(waybill.provider_waybill_id).toBe("IRS-1");
    expect(waybill.created_by).toBe(actor.id);
  });

  it("ayni hareket icin ikinci kez cagrilirsa (upsert) eski kaydin uzerine yazar, ikinci satir olusturmaz", () => {
    const movementId = createTestMovementId();
    recordWaybillSuccess(station.id, movementId, "IRS-OLD", actor);
    recordWaybillSuccess(station.id, movementId, "IRS-NEW", actor);
    const count = db.prepare<[number], { c: number }>("SELECT COUNT(*) as c FROM waybills WHERE movement_id = ?").get(movementId)!.c;
    expect(count).toBe(1);
    expect(getWaybillForMovement(movementId)?.provider_waybill_id).toBe("IRS-NEW");
  });

  it("onceki bir basarisizligin hata mesajini temizler", () => {
    const movementId = createTestMovementId();
    recordWaybillFailure(station.id, movementId, "baglanti hatasi", actor);
    const waybill = recordWaybillSuccess(station.id, movementId, "IRS-2", actor);
    expect(waybill.status).toBe("sent");
    expect(waybill.error_message).toBeNull();
  });
});

describe("recordWaybillFailure", () => {
  it("basarisiz irsaliyeyi 'failed' statusu ve hata mesajiyla kaydeder", () => {
    const movementId = createTestMovementId();
    const waybill = recordWaybillFailure(station.id, movementId, "saglayiciya baglanilamadi", actor);
    expect(waybill.status).toBe("failed");
    expect(waybill.error_message).toBe("saglayiciya baglanilamadi");
    expect(waybill.provider_waybill_id).toBeNull();
  });
});

describe("serializeWaybill", () => {
  it("istemciye donecek alanlari dogru esler", () => {
    const movementId = createTestMovementId();
    const waybill = recordWaybillSuccess(station.id, movementId, "IRS-3", actor);
    expect(serializeWaybill(waybill)).toEqual({
      status: "sent",
      providerWaybillId: "IRS-3",
      errorMessage: null,
      createdAt: waybill.created_at,
    });
  });
});
