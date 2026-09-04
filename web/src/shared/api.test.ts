import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { setCurrentStationId } from "./stationScope";

/**
 * Gercek uretim hatasi: musteri panelinde (super_admin/tenant_admin) bir istasyon
 * secilmisse appendStationParam bunu HER api.get() cagrisina ekliyordu - kiosk uclari
 * KENDI stationId'lerini zaten query'e yazdigi icin (bkz. kioskApi.ts) sonuc iki
 * ayni-adli query parametresiydi (?stationId=1&plate=X&stationId=5). Express bunu
 * DIZIYE cevirir; sunucudaki z.coerce.number() NaN ile patlar ve istek sessizce 400
 * doner - musteri hicbir hata gormeden filo odemesi/yanlis yakit kontrolu calismaz.
 *
 * Ayni tarayicida hem admin paneli hem kiosk kullanildiginda (ör. istasyon
 * personelinin ayni cihazi kullanmasi) bu HER ZAMAN tetiklenirdi.
 */
describe("api.get - /api/kiosk/* istasyon kapsamindan bagimsizdir", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
    );
  });

  afterEach(() => {
    setCurrentStationId(null);
    vi.unstubAllGlobals();
  });

  it("admin panelinde bir istasyon secili olsa bile kiosk isteklerine ikinci bir stationId eklenmez", async () => {
    setCurrentStationId(5);

    await api.get("/api/kiosk/fleet-account?stationId=1&plate=06VY894");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("/api/kiosk/fleet-account?stationId=1&plate=06VY894");
  });

  it("kiosk disindaki (admin/operator) uclar icin secili istasyon hala eklenir", async () => {
    setCurrentStationId(5);

    await api.get("/api/fleet-accounts");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("/api/fleet-accounts?stationId=5");
  });
});
