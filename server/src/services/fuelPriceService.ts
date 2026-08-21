import { db } from "../db/index.js";
import type { FuelPriceRow } from "../db/types.js";
import { getAvailableLiters } from "./fuelStockService.js";
import { broadcast } from "../ws/hub.js";

/**
 * Kiosk, fiyatlari sadece sayfa ilk yuklendiginde cekiyordu; sayfa yenilenmedigi
 * (kiosk saatlerce/gunlerce ayni sekmede acik kaldigi) icin fiyat degisikligi
 * (manuel veya zamanlanmis) ile musterinin ekranda gordugu fiyat arasinda uzun bir
 * bayatlama penceresi olusabiliyordu. Pompa/stok durumu icin zaten var olan ayni
 * WS yayin desenini (bkz. pumpService/fuelStockService) fiyatlar icin de kullanarak
 * bu pencereyi pratikte sifira indirir.
 */
export function serializeFuelPricesForBroadcast(stationId: number) {
  const prices = db.prepare<[number], FuelPriceRow>("SELECT * FROM fuel_prices WHERE station_id = ?").all(stationId);
  return prices.map((p) => ({
    fuelType: p.fuel_type,
    label: p.label,
    pricePerLiter: p.price_per_liter,
    inStock: getAvailableLiters(stationId, p.fuel_type) > 0,
  }));
}

export function broadcastFuelPrices(stationId: number): void {
  broadcast(`fuel-prices:${stationId}`, serializeFuelPricesForBroadcast(stationId));
}
