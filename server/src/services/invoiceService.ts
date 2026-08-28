import type { FuelType, TransactionRow } from "../db/types.js";
import { getInvoiceConfig, isInvoiceReady, uyumsoftBaseUrl } from "./invoiceSettingsService.js";

export class InvoiceError extends Error {
  constructor(
    message: string,
    public status = 502
  ) {
    super(message);
  }
}

// Turkiye'de akaryakit pompa fiyati KDV dahildir; e-Fatura/e-Arsiv satirinda KDV'siz
// birim fiyat ve KDV tutari ayri ayri gosterilmelidir. Genel KDV orani (2026): %20.
// export edilir: accountingExportService.ts ayni orani kullanir, iki yerde KDV orani
// driftlemesin diye.
export const VAT_RATE = 0.2;

const FUEL_LABELS: Record<FuelType, string> = {
  benzin: "Kursunsuz Benzin",
  motorin: "Motorin (Diesel)",
  lpg: "Otogaz LPG",
};

export interface CreateInvoiceResult {
  providerInvoiceId: string;
}

/**
 * Tamamlanmis bir kiosk satisi icin GERCEK bir e-Arsiv fatura (UBL-TR) olusturur.
 * Uyumsoft'un dokumante edilmis REST entegrasyon API'sine (BasicIntegrationApi,
 * action=SendInvoice) gore yazilmistir - bkz. https://developer.turkcellesirket.com/fatura
 * ve Uyumsoft'un yayinladigi ornek entegrasyonlar. Bu bir SIMULASYON DEGILDIR: istasyon
 * kendi Uyumsoft musteri hesabinin (username/password) bilgilerini girdiginde gercekten
 * bu adrese HTTP istegi atar. Saglayici baglanmadan (kullanici adi/sifre girilmeden)
 * cagirilirsa isInvoiceReady() false doner ve bu fonksiyon hic calismaz.
 *
 * Musteri (alici) bilgisi kiosk'ta toplanmadigi icin Turkiye'de akaryakit
 * istasyonlarinda yaygin uygulama olan "Nihai Tuketici" (VKN/TCKN'siz perakende
 * e-Arsiv) olarak kesilir - plaka, aciklama alaninda referans olarak yer alir.
 */
export async function createInvoice(t: TransactionRow): Promise<CreateInvoiceResult> {
  const readiness = isInvoiceReady(t.station_id);
  if (!readiness.ready) throw new InvoiceError(readiness.reason ?? "E-fatura kullanima hazir degil.", 409);
  if (t.status !== "completed") throw new InvoiceError("Yalnizca tamamlanmis islemler icin fatura kesilebilir.", 409);

  const config = getInvoiceConfig(t.station_id);
  const chargeAmount = Math.max(0, Math.round((t.total_amount - t.discount_amount) * 100) / 100);
  const taxExclusiveAmount = Math.round((chargeAmount / (1 + VAT_RATE)) * 100) / 100;
  const taxAmount = Math.round((chargeAmount - taxExclusiveAmount) * 100) / 100;
  const now = new Date();
  const fuelLabel = FUEL_LABELS[t.fuel_type] ?? t.fuel_type;

  const requestBody = {
    userInfo: { Username: config.username, Password: config.password },
    Invoice: {
      IssueDate: now.toISOString().slice(0, 10),
      IssueTime: now.toISOString().slice(11, 19),
      InvoiceTypeCode: "SATIS",
      DocumentCurrencyCode: "TRY",
      UblVersionId: "2.1",
      CustomizationId: "TR1.2",
      DeliveryType: "Electronic", // e-Arsiv
      AccountingSupplierParty: {
        VKN: config.companyVkn,
        PartyName: config.companyTitle,
        TaxOffice: config.companyTaxOffice ?? "",
        Address: {
          StreetName: config.companyAddress ?? "",
          CitySubdivisionName: config.companyDistrict ?? "",
          CityName: config.companyCity ?? "",
          Country: "Turkiye",
        },
      },
      AccountingCustomerParty: {
        // Perakende akaryakit satisinda musteri kimligi kiosk'ta toplanmaz -
        // "Nihai Tuketici" (bireysel, VKN/TCKN'siz) e-Arsiv olarak kesilir.
        PartyName: "Nihai Tuketici",
        Note: `Plaka: ${t.plate}`,
      },
      InvoiceLine: [
        {
          Id: 1,
          InvoicedQuantity: Math.round(t.dispensed_liters * 1000) / 1000,
          UnitCode: "LTR",
          Item: { Name: `${fuelLabel} (Plaka: ${t.plate})` },
          Price: { PriceAmount: Math.round((taxExclusiveAmount / t.dispensed_liters) * 100) / 100 },
          LineExtensionAmount: taxExclusiveAmount,
          TaxTotal: { TaxAmount: taxAmount, TaxScheme: "KDV", Percent: VAT_RATE * 100 },
        },
      ],
      LegalMonetaryTotal: {
        LineExtensionAmount: taxExclusiveAmount,
        TaxExclusiveAmount: taxExclusiveAmount,
        TaxInclusiveAmount: chargeAmount,
        PayableAmount: chargeAmount,
      },
    },
  };

  const url = `${uyumsoftBaseUrl(config.environment)}/api/BasicIntegrationApi`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Action: "SendInvoice", ...requestBody }),
    });
  } catch (err) {
    throw new InvoiceError(`E-fatura saglayicisina baglanilamadi: ${err instanceof Error ? err.message : "bilinmeyen hata"}`, 502);
  }

  if (!response.ok) {
    throw new InvoiceError(`E-fatura saglayicisi hata dondu (HTTP ${response.status}).`, 502);
  }

  const result = (await response.json().catch(() => null)) as { InvoiceId?: string; Success?: boolean; ErrorMessage?: string } | null;
  if (!result || result.Success === false || !result.InvoiceId) {
    throw new InvoiceError(result?.ErrorMessage ?? "E-fatura saglayicisi gecersiz yanit dondurdu.", 502);
  }

  return { providerInvoiceId: result.InvoiceId };
}
