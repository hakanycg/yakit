import type { FuelStockMovementRow, FuelType } from "../db/types.js";
import { getInvoiceConfig, isInvoiceReady, uyumsoftBaseUrl } from "./invoiceSettingsService.js";

export class WaybillError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
  }
}

const FUEL_LABELS: Record<FuelType, string> = {
  benzin: "Kursunsuz Benzin",
  motorin: "Motorin (Diesel)",
  lpg: "Otogaz LPG",
};

export interface CreateWaybillResult {
  providerWaybillId: string;
}

/**
 * Bir yakit teslimati (tanker sevkiyati) icin GERCEK bir e-Irsaliye (UBL-TR DespatchAdvice)
 * olusturur. Uyumsoft'un ayni BasicIntegrationApi'sini (e-Fatura ile paylasilan hesap/kimlik
 * bilgileri - bkz. invoiceSettingsService.ts) Action=SendDespatchAdvice ile kullanir. UBL-TR
 * DespatchAdvice govde yapisi (DespatchSupplierParty, DeliveryCustomerParty, Shipment/Delivery,
 * DespatchLine/DeliveredQuantity) OASIS UBL 2.1 DespatchAdvice ornegine ve GIB'in yayinladigi
 * UBL-TR Sevk Irsaliyesi semasina gore yazilmistir. SIMULASYON DEGILDIR: saglayici baglanmadan
 * (Ayarlar -> Fatura Ayarlari altinda Uyumsoft kullanici adi/sifresi girilmeden) cagirilirsa
 * isInvoiceReady() false doner ve bu fonksiyon hic calismaz.
 *
 * Not: Gercek is akisinda e-Irsaliye'yi genelde malI sevk eden taraf (tedarikci/tasiyici)
 * duzenler; burada istasyon, kendi kayitlarinda GIB'e bildirilen resmi bir teslim alma
 * belgesi olusturmak icin kendi Uyumsoft hesabindan bu belgeyi yaratir.
 */
export async function createWaybill(movement: FuelStockMovementRow): Promise<CreateWaybillResult> {
  const readiness = isInvoiceReady(movement.station_id);
  if (!readiness.ready) throw new WaybillError(readiness.reason ?? "E-irsaliye kullanima hazir degil.", 409);
  if (movement.type !== "delivery") throw new WaybillError("Yalnizca teslimat hareketleri icin irsaliye kesilebilir.", 409);

  const config = getInvoiceConfig(movement.station_id);
  const now = new Date();
  const deliveryDate = movement.created_at.slice(0, 10);
  const fuelLabel = FUEL_LABELS[movement.fuel_type] ?? movement.fuel_type;

  const requestBody = {
    userInfo: { Username: config.username, Password: config.password },
    DespatchAdvice: {
      ID: `IRS-${movement.id}`,
      IssueDate: now.toISOString().slice(0, 10),
      IssueTime: now.toISOString().slice(11, 19),
      DespatchAdviceTypeCode: "SEVK",
      Note: movement.delivery_ref ? `Irsaliye/Fis No: ${movement.delivery_ref}` : undefined,
      DespatchSupplierParty: {
        Party: {
          PartyName: { Name: movement.supplier ?? "Bilinmeyen Tedarikci" },
        },
      },
      DeliveryCustomerParty: {
        Party: {
          PartyName: { Name: config.companyTitle },
          PartyTaxScheme: { VKN: config.companyVkn, TaxOffice: config.companyTaxOffice ?? "" },
          PostalAddress: {
            StreetName: config.companyAddress ?? "",
            CitySubdivisionName: config.companyDistrict ?? "",
            CityName: config.companyCity ?? "",
            Country: "Turkiye",
          },
        },
      },
      Shipment: {
        Delivery: {
          ActualDeliveryDate: deliveryDate,
          DeliveryAddress: {
            StreetName: config.companyAddress ?? "",
            CitySubdivisionName: config.companyDistrict ?? "",
            CityName: config.companyCity ?? "",
            Country: "Turkiye",
          },
        },
      },
      DespatchLine: [
        {
          ID: 1,
          DeliveredQuantity: Math.round(movement.liters * 1000) / 1000,
          UnitCode: "LTR",
          Item: { Name: fuelLabel },
        },
      ],
    },
  };

  const url = `${uyumsoftBaseUrl(config.environment)}/api/BasicIntegrationApi`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Action: "SendDespatchAdvice", ...requestBody }),
    });
  } catch (err) {
    throw new WaybillError(`E-irsaliye saglayicisina baglanilamadi: ${err instanceof Error ? err.message : "bilinmeyen hata"}`, 502);
  }

  if (!response.ok) {
    throw new WaybillError(`E-irsaliye saglayicisi hata dondu (HTTP ${response.status}).`, 502);
  }

  const result = (await response.json().catch(() => null)) as { DespatchId?: string; Success?: boolean; ErrorMessage?: string } | null;
  if (!result || result.Success === false || !result.DespatchId) {
    throw new WaybillError(result?.ErrorMessage ?? "E-irsaliye saglayicisi gecersiz yanit dondurdu.", 502);
  }

  return { providerWaybillId: result.DespatchId };
}
