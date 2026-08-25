import { db } from "../db/index.js";
import type { FleetAccountRow, FleetInvoiceRow, UserRow } from "../db/types.js";
import { getAccountById } from "./fleetService.js";
import { getInvoiceConfig, isInvoiceReady, uyumsoftBaseUrl } from "./invoiceSettingsService.js";
import { InvoiceError } from "./invoiceService.js";
import { logger } from "../utils/logger.js";

/**
 * Filo donem (icmal) faturasi.
 *
 * Mevcut e-Fatura yolu (invoices tablosu) TEK BIR ISLEME baglidir ve alici kimligi
 * kiosk'ta toplanmadigi icin "Nihai Tuketici" e-Arsiv olarak kesilir. Kurumsal bir
 * musteri icin bu iki yonden de yanlistir: ayda 200 kez dolum yapan nakliye sirketine
 * 200 perakende fisi degil, KENDI VKN'siyle donem basina TEK fatura gerekir.
 *
 * KAPSAM TARIHLE DEGIL, HAREKETLE BELIRLENIR. Fatura "1-31 Agustos arasi" diye
 * secilseydi, 30 Agustos'ta girilmis ama 2 Eylul'de fark edilen bir hareket ya iki kez
 * faturalanir ya da hic faturalanmazdi. Onun yerine her hareket faturalandiginda
 * fleet_movements.fleet_invoice_id yazilir; bir sonraki fatura yalnizca NULL olanlari
 * toplar. Boylece gec gelen bir hareket sessizce kaybolmaz, siradaki faturaya duser ve
 * hicbir hareket iki faturada birden cikamaz.
 */

/** Turkiye'de akaryakit pompa fiyati KDV dahildir; faturada KDV ayrisir. Genel oran (2026): %20. */
const VAT_RATE = 0.2;

const FUEL_LABELS: Record<string, string> = {
  benzin: "Kursunsuz Benzin",
  motorin: "Motorin (Diesel)",
  lpg: "Otogaz LPG",
};

export class FleetInvoiceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface FleetInvoiceLine {
  plate: string;
  fuelType: string;
  liters: number;
  /** KDV dahil tutar (tahsilat - iade). */
  amount: number;
  /** KDV haric tutar. Satirda SAKLANIR, her yerde yeniden hesaplanmaz - bkz. buildLines. */
  taxExclusiveAmount: number;
  taxAmount: number;
}

export interface FleetInvoiceDraft {
  /** Faturalanacak hareket sayisi. 0 ise kesilecek bir sey yok. */
  movementCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  lines: FleetInvoiceLine[];
  totalLiters: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  payableAmount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface PendingMovement {
  id: number;
  type: string;
  amount: number;
  created_at: string;
  plate: string | null;
  fuel_type: string | null;
  liters: number | null;
}

/**
 * Henuz faturalanmamis hareketler.
 *
 * Yalnizca yakit alimi (charge) ve iadesi (refund) faturaya girer. Bakiye yuklemesi
 * (topup) bir SATIS degil ODEMEDIR - faturalanirsa musteri odedigi para icin ikinci kez
 * borclandirilmis olur. Duzeltme (adjustment) de disaridadir: elle yapilan bir
 * duzeltmenin faturaya hangi gerekceyle, hangi kalem adiyla girecegi operatorun
 * kararidir, sessizce bir yakit satiri uydurmak dogru olmaz.
 */
function pendingMovements(accountId: number): PendingMovement[] {
  return db
    .prepare<[number], PendingMovement>(
      `SELECT m.id, m.type, m.amount, m.created_at,
              t.plate AS plate, t.fuel_type AS fuel_type, t.dispensed_liters AS liters
       FROM fleet_movements m
       LEFT JOIN transactions t ON t.id = m.transaction_id
       WHERE m.fleet_account_id = ?
         AND m.fleet_invoice_id IS NULL
         AND m.type IN ('charge', 'refund')
       ORDER BY m.created_at, m.id`
    )
    .all(accountId);
}

/**
 * Satirlar plaka + yakit tipi bazinda toplanir.
 *
 * Her dolum ayri satir olsaydi 200 dolumlu bir ayda 200 satirlik bir fatura cikardi;
 * musterinin isine yarayan kirilim "hangi arac, hangi yakittan ne kadar"dir. Dolum
 * dokumu zaten portalin ekstresinde ve CSV'sinde duruyor.
 *
 * Iade, ait oldugu plakanin satirindan DUSULUR. Iadenin islemi silinmis/bulunamiyorsa
 * ayri bir "Iade" satirinda gosterilir - toplamdan sessizce dusurmek, faturanin
 * kalemleri toplamiyla genel toplaminin tutmamasi demek olurdu.
 */
function buildLines(movements: PendingMovement[]): FleetInvoiceLine[] {
  const byKey = new Map<string, FleetInvoiceLine>();

  for (const m of movements) {
    const plate = m.plate ?? "—";
    const fuelType = m.fuel_type ?? "—";
    const key = `${plate}|${fuelType}`;
    const sign = m.type === "refund" ? -1 : 1;
    const line = byKey.get(key) ?? { plate, fuelType, liters: 0, amount: 0, taxExclusiveAmount: 0, taxAmount: 0 };
    line.liters = round3(line.liters + sign * (m.liters ?? 0));
    line.amount = round2(line.amount + sign * m.amount);
    byKey.set(key, line);
  }

  // KDV satir bazinda AYRISTIRILIR ve saklanir; fatura basligi bu satirlarin toplamidir
  // (bkz. draftFromMovements). Baslik bagimsiz hesaplansaydi yuvarlama satir toplamiyla
  // 1 kurus ayrisabilirdi - GIB, kalemleri genel toplamiyla tutmayan bir belgeyi reddeder.
  return [...byKey.values()]
    // Tamami iade edilmis bir plaka sifir tutarli bir satir birakir; faturada yeri yok.
    .filter((l) => l.amount !== 0 || l.liters !== 0)
    .map((l) => {
      const taxExclusiveAmount = round2(l.amount / (1 + VAT_RATE));
      return { ...l, taxExclusiveAmount, taxAmount: round2(l.amount - taxExclusiveAmount) };
    });
}

function draftFromMovements(movements: PendingMovement[]): FleetInvoiceDraft {
  const lines = buildLines(movements);
  // Baslik toplamlari SATIRLARDAN turetilir, bagimsiz hesaplanmaz: aksi halde satir
  // basina yuvarlama ile baslik arasinda 1 kuruslik bir fark olusabilir ve fatura
  // kalemleri genel toplamiyla tutmazdi.
  const payableAmount = round2(lines.reduce((n, l) => n + l.amount, 0));
  const taxExclusiveAmount = round2(lines.reduce((n, l) => n + l.taxExclusiveAmount, 0));

  return {
    movementCount: movements.length,
    periodStart: movements[0]?.created_at ?? null,
    periodEnd: movements[movements.length - 1]?.created_at ?? null,
    lines,
    totalLiters: round3(lines.reduce((n, l) => n + l.liters, 0)),
    taxExclusiveAmount,
    taxAmount: round2(payableAmount - taxExclusiveAmount),
    payableAmount,
  };
}

/** Kesilecek faturanin onizlemesi: personel neyi imzalayacagini once gorur. */
export function getInvoiceDraft(stationId: number, accountId: number): FleetInvoiceDraft {
  getAccountById(stationId, accountId);
  return draftFromMovements(pendingMovements(accountId));
}

/**
 * Hesabin faturalari. Kapsam kontrolu YOKTUR - cagiran taraf zaten yapmis olmalidir:
 * personel tarafinda getAccountById (istasyon kapsami), musteri portalinda
 * assertAccountAccess (baglanti kapsami). Iki farkli kapsam kurali oldugu icin
 * kontrol burada degil, cagiranda durur.
 */
export function listInvoicesForAccount(accountId: number): FleetInvoiceRow[] {
  return db
    .prepare<[number], FleetInvoiceRow>("SELECT * FROM fleet_invoices WHERE fleet_account_id = ? ORDER BY created_at DESC")
    .all(accountId);
}

export function listFleetInvoices(stationId: number, accountId: number): FleetInvoiceRow[] {
  getAccountById(stationId, accountId);
  return listInvoicesForAccount(accountId);
}

/**
 * Uyumsoft'a KURUMSAL e-Fatura gonderir (perakende e-Arsiv degil).
 *
 * invoiceService.createInvoice ile ayni API'yi kullanir ama alici tarafi farklidir:
 * orada alici "Nihai Tuketici"dir, burada musterinin kendi VKN'si ve unvani gider.
 * Iki fonksiyonu birlestirmek, iki farkli belge turunun kurallarini tek govdede
 * if'lerle tasimak demek olurdu.
 */
async function sendToProvider(
  account: FleetAccountRow,
  draft: FleetInvoiceDraft,
  periodStart: string,
  periodEnd: string
): Promise<string> {
  const config = getInvoiceConfig(account.station_id);
  const now = new Date();

  const requestBody = {
    userInfo: { Username: config.username, Password: config.password },
    Invoice: {
      IssueDate: now.toISOString().slice(0, 10),
      IssueTime: now.toISOString().slice(11, 19),
      InvoiceTypeCode: "SATIS",
      DocumentCurrencyCode: "TRY",
      UblVersionId: "2.1",
      CustomizationId: "TR1.2",
      // Alicinin VKN'si oldugu icin e-Arsiv degil e-Fatura: belge dogrudan musterinin
      // GIB posta kutusuna duser.
      DeliveryType: "ElectronicInvoice",
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
        VKN: account.vkn,
        PartyName: account.company_name,
        Note: `Donem: ${periodStart.slice(0, 10)} - ${periodEnd.slice(0, 10)}`,
      },
      InvoiceLine: draft.lines.map((l, i) => ({
        Id: i + 1,
        InvoicedQuantity: l.liters,
        UnitCode: "LTR",
        Item: { Name: `${FUEL_LABELS[l.fuelType] ?? l.fuelType} (Plaka: ${l.plate})` },
        // Litre sifirsa (ör. islemi bulunamayan bir iade satiri) birim fiyat
        // hesaplanamaz; 0'a bolmek yerine tutari dogrudan satir tutari olarak veririz.
        Price: { PriceAmount: l.liters !== 0 ? round2(l.taxExclusiveAmount / l.liters) : l.taxExclusiveAmount },
        LineExtensionAmount: l.taxExclusiveAmount,
        TaxTotal: { TaxAmount: l.taxAmount, TaxScheme: "KDV", Percent: VAT_RATE * 100 },
      })),
      LegalMonetaryTotal: {
        LineExtensionAmount: draft.taxExclusiveAmount,
        TaxExclusiveAmount: draft.taxExclusiveAmount,
        TaxInclusiveAmount: draft.payableAmount,
        PayableAmount: draft.payableAmount,
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
  if (!response.ok) throw new InvoiceError(`E-fatura saglayicisi hata dondu (HTTP ${response.status}).`, 502);

  const result = (await response.json().catch(() => null)) as { InvoiceId?: string; Success?: boolean; ErrorMessage?: string } | null;
  if (!result || result.Success === false || !result.InvoiceId) {
    throw new InvoiceError(result?.ErrorMessage ?? "E-fatura saglayicisi gecersiz yanit dondurdu.", 502);
  }
  return result.InvoiceId;
}

/**
 * Donem faturasini keser.
 *
 * Sira onemli: once hareketler faturaya BAGLANIR (tek bir DB islemi icinde, yalnizca
 * fleet_invoice_id'si hala NULL olanlar), sonra saglayiciya gonderilir. Tersi sirada,
 * saglayici cevabi gecikirken ayni hesap icin ikinci bir fatura baslatilsa ayni
 * hareketler iki kez faturalanirdi - kurumsal bir musteriyi cift borclandirmak, bu
 * ozellikteki en agir hatadir.
 *
 * Gonderim basarisiz olursa fatura kaydi 'failed' olarak KALIR ve hareketler ona bagli
 * kalir; personel ayni faturayi yeniden gonderir (retryFleetInvoice). Baglanti geri
 * alinsaydi, saglayiciya gercekte ulasmis olan bir belge ikinci kez kesilebilirdi.
 */
export async function createPeriodInvoice(stationId: number, accountId: number, actor: UserRow): Promise<FleetInvoiceRow> {
  const account = getAccountById(stationId, accountId);

  const readiness = isInvoiceReady(stationId);
  if (!readiness.ready) throw new FleetInvoiceError(readiness.reason ?? "E-fatura kullanima hazir degil.", 409);
  if (!account.vkn) {
    throw new FleetInvoiceError("Kurumsal fatura icin filo hesabina VKN girilmelidir.", 409);
  }

  const invoiceId = db.transaction(() => {
    // Kilit ayni islem icinde: iki es zamanli istek de burada ayni hareketleri gormeye
    // calisir, ikincisinin UPDATE'i hicbir satiri etkilemez ve bos fatura reddedilir.
    const movements = pendingMovements(accountId);
    if (movements.length === 0) throw new FleetInvoiceError("Faturalanacak yeni hareket yok.", 409);
    const draft = draftFromMovements(movements);
    if (draft.payableAmount <= 0) {
      // Tahsilatlarin tamami iade edilmisse fatura kesilecek bir tutar yoktur.
      throw new FleetInvoiceError("Faturalanacak tutar sifir veya negatif; fatura kesilemez.", 409);
    }

    const periodStart = draft.periodStart!;
    const periodEnd = draft.periodEnd!;
    const result = db
      .prepare(
        `INSERT INTO fleet_invoices
           (station_id, fleet_account_id, status, period_start, period_end,
            total_liters, tax_exclusive_amount, tax_amount, payable_amount, lines_json, created_by)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stationId,
        accountId,
        periodStart,
        periodEnd,
        draft.totalLiters,
        draft.taxExclusiveAmount,
        draft.taxAmount,
        draft.payableAmount,
        JSON.stringify(draft.lines),
        actor.id
      );
    const id = result.lastInsertRowid as number;

    const bind = db.prepare("UPDATE fleet_movements SET fleet_invoice_id = ? WHERE id = ? AND fleet_invoice_id IS NULL");
    let bound = 0;
    for (const m of movements) bound += bind.run(id, m.id).changes;
    if (bound !== movements.length) {
      // Araya baska bir fatura girmis: bu islemi geri alip personelin yeniden
      // denemesini istemek, eksik kapsamli bir fatura kesmekten iyidir.
      throw new FleetInvoiceError("Hareketler bu sirada baska bir fatura tarafindan alindi. Lutfen tekrar deneyin.", 409);
    }
    return id;
  })();

  return sendInvoice(invoiceId);
}

function getFleetInvoiceRow(id: number): FleetInvoiceRow {
  const row = db.prepare<[number], FleetInvoiceRow>("SELECT * FROM fleet_invoices WHERE id = ?").get(id);
  if (!row) throw new FleetInvoiceError("Fatura bulunamadi.", 404);
  return row;
}

/** Saglayiciya gonderir ve sonucu kaydeder. Hata yutulmaz: kayit 'failed' olur, sebep saklanir. */
async function sendInvoice(invoiceId: number): Promise<FleetInvoiceRow> {
  const invoice = getFleetInvoiceRow(invoiceId);
  const account = db
    .prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?")
    .get(invoice.fleet_account_id)!;
  const draft: FleetInvoiceDraft = {
    movementCount: 0,
    periodStart: invoice.period_start,
    periodEnd: invoice.period_end,
    lines: JSON.parse(invoice.lines_json) as FleetInvoiceLine[],
    totalLiters: invoice.total_liters,
    taxExclusiveAmount: invoice.tax_exclusive_amount,
    taxAmount: invoice.tax_amount,
    payableAmount: invoice.payable_amount,
  };

  try {
    const providerInvoiceId = await sendToProvider(account, draft, invoice.period_start, invoice.period_end);
    db.prepare("UPDATE fleet_invoices SET status = 'sent', provider_invoice_id = ?, error_message = NULL WHERE id = ?").run(
      providerInvoiceId,
      invoiceId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bilinmeyen hata";
    db.prepare("UPDATE fleet_invoices SET status = 'failed', error_message = ? WHERE id = ?").run(message, invoiceId);
    logger.error({ err, invoiceId, accountId: account.id }, "Filo donem faturasi gonderilemedi.");
  }

  return getFleetInvoiceRow(invoiceId);
}

/**
 * Basarisiz bir faturayi YENIDEN GONDERIR - yenisini kesmez.
 *
 * Hareketler zaten bu faturaya bagli oldugundan yeni bir fatura kesmek onlari
 * kapsayamaz; kapsasaydi ayni yakit iki belgede birden faturalanirdi.
 */
export async function retryFleetInvoice(stationId: number, accountId: number, invoiceId: number): Promise<FleetInvoiceRow> {
  getAccountById(stationId, accountId);
  const invoice = getFleetInvoiceRow(invoiceId);
  // Erisilemeyen fatura ile var olmayan fatura ayni cevabi dondurur.
  if (invoice.fleet_account_id !== accountId || invoice.station_id !== stationId) {
    throw new FleetInvoiceError("Fatura bulunamadi.", 404);
  }
  if (invoice.status === "sent") throw new FleetInvoiceError("Bu fatura zaten gonderildi.", 409);
  return sendInvoice(invoiceId);
}

export function serializeFleetInvoice(i: FleetInvoiceRow) {
  return {
    id: i.id,
    status: i.status,
    providerInvoiceId: i.provider_invoice_id,
    errorMessage: i.error_message,
    periodStart: i.period_start,
    periodEnd: i.period_end,
    totalLiters: i.total_liters,
    taxExclusiveAmount: i.tax_exclusive_amount,
    taxAmount: i.tax_amount,
    payableAmount: i.payable_amount,
    lines: JSON.parse(i.lines_json) as FleetInvoiceLine[],
    createdAt: i.created_at,
  };
}
