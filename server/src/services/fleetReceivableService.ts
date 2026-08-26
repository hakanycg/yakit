import { db } from "../db/index.js";
import type { FleetAccountRow, FleetInvoiceRow } from "../db/types.js";
import { logger } from "../utils/logger.js";
import { broadcastAlarms, createAlarm } from "./alarmService.js";
import { sendEmail, sendSms } from "./notificationService.js";

/**
 * Faturali (postpaid) filo hesaplarinda ALACAK TAKIBI.
 *
 * Sistemde "ne kadar borcu var" bilgisi vardi (fleet_accounts.balance), "NE KADAR
 * SUREDIR odemedi" bilgisi yoktu. Akaryakitta en buyuk nakit riski budur: on odemeli
 * hesapta bakiye bitince pompa zaten durur, faturali hesapta ise borc sessizce buyur.
 *
 * Defter TURETILIR, ayri bir tabloda tutulmaz - portalin ekstresiyle ayni felsefe.
 * Kaynaklar:
 *   - Faturalanmis alacak: fleet_invoices.payable_amount
 *   - Tahsilat havuzu:     fleet_movements type='topup'
 *   - Faturalanmamis:      fleet_invoice_id IS NULL olan charge/refund hareketleri
 *
 * IADELER HAVUZA GIRMEZ. Donem faturasi kesilirken iadeler zaten ilgili plakanin
 * satirindan dusuluyor (bkz. fleetInvoiceService.buildLines), yani faturalanmis bir
 * iade faturanin tutarinin icinde netlenmis durumda; faturalanmamis bir iade ise
 * bir sonraki faturada netlenecek. Iadeyi bir de tahsilat sayarsak ayni parayi iki
 * kez dusmus oluruz.
 */

/** Odemeler en ESKI faturadan baslayarak kapatilir (FIFO) - muhasebede olagan varsayim. */
export interface InvoiceReceivable {
  invoiceId: number;
  status: FleetInvoiceRow["status"];
  /** Fatura musteriye fiilen iletildi mi? Iletilmemis faturanin vadesi islemez. */
  delivered: boolean;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueDate: string | null;
  payableAmount: number;
  paidAmount: number;
  remainingAmount: number;
  /** Vadesi gecmis gun sayisi; vadesi gelmemis, vadesiz ya da kapanmis faturada 0. */
  daysOverdue: number;
}

export interface AgingBuckets {
  /** Vadesi henuz gelmemis (ya da vade tanimsiz) acik tutar. */
  current: number;
  d1to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
}

export interface AccountReceivable {
  accountId: number;
  companyName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTermDays: number | null;
  overdueBlockDays: number | null;
  invoices: InvoiceReceivable[];
  /** Kesilmis ve henuz kapanmamis fatura toplami. */
  openAmount: number;
  /** Vadesi gecmis kisim (openAmount'un alt kumesi). */
  overdueAmount: number;
  /** Yakit alinmis ama henuz faturalanmamis tutar - borctur, ama vadesi baslamamistir. */
  unbilledAmount: number;
  /** Tahsilat, acik faturalarin toplamini asiyorsa olusan alacakli bakiye. */
  creditAmount: number;
  /** En eski vadesi gecmis faturanin gun sayisi; yoksa 0. */
  oldestOverdueDays: number;
  buckets: AgingBuckets;
}

const DAY_MS = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Gun farki TAM GUN olarak sayilir: vadesi bugun dolan bir fatura "1 gun gecikmis"
 * degildir. Saat farkiyla gecikmeye dusen bir fatura, musteriyi sabahin korunde
 * hatirlatma e-postasiyla karsilastirirdi.
 */
function daysBetween(from: string, now: number): number {
  return Math.floor((now - Date.parse(from)) / DAY_MS);
}

function paymentPool(accountId: number): number {
  const row = db
    .prepare<[number], { total: number | null }>(
      "SELECT SUM(amount) AS total FROM fleet_movements WHERE fleet_account_id = ? AND type = 'topup'"
    )
    .get(accountId);
  return round2(row?.total ?? 0);
}

function unbilledAmount(accountId: number): number {
  const row = db
    .prepare<[number], { total: number | null }>(
      `SELECT SUM(CASE WHEN type = 'refund' THEN -amount ELSE amount END) AS total
         FROM fleet_movements
        WHERE fleet_account_id = ? AND fleet_invoice_id IS NULL AND type IN ('charge','refund')`
    )
    .get(accountId);
  return round2(row?.total ?? 0);
}

function invoicesOldestFirst(accountId: number): FleetInvoiceRow[] {
  return db
    .prepare<[number], FleetInvoiceRow>(
      "SELECT * FROM fleet_invoices WHERE fleet_account_id = ? ORDER BY created_at, id"
    )
    .all(accountId);
}

function emptyBuckets(): AgingBuckets {
  return { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0 };
}

function addToBucket(buckets: AgingBuckets, daysOverdue: number, amount: number): void {
  if (daysOverdue <= 0) buckets.current = round2(buckets.current + amount);
  else if (daysOverdue <= 30) buckets.d1to30 = round2(buckets.d1to30 + amount);
  else if (daysOverdue <= 60) buckets.d31to60 = round2(buckets.d31to60 + amount);
  else if (daysOverdue <= 90) buckets.d61to90 = round2(buckets.d61to90 + amount);
  else buckets.d90plus = round2(buckets.d90plus + amount);
}

/**
 * Bir hesabin alacak defteri.
 *
 * Vadesi gecmis sayilmanin UC kosulu birden aranir: fatura musteriye iletilmis
 * olacak (status='sent'), vade tarihi tanimli olacak ve o tarih gecmis olacak.
 * Iletilememis bir faturanin pesine dusmek yanlistir - musteri o faturayi hic
 * gormedi (bkz. fleet_invoices.status='failed', yeniden gonderim yolu mevcut).
 */
export function accountReceivable(account: FleetAccountRow, now = Date.now()): AccountReceivable {
  let pool = paymentPool(account.id);
  const buckets = emptyBuckets();
  const invoices: InvoiceReceivable[] = [];
  let openAmount = 0;
  let overdueAmount = 0;
  let oldestOverdueDays = 0;

  for (const inv of invoicesOldestFirst(account.id)) {
    // FIFO: havuzdaki para once en eski faturayi kapatir.
    const paidAmount = round2(Math.min(pool, inv.payable_amount));
    pool = round2(pool - paidAmount);
    const remainingAmount = round2(inv.payable_amount - paidAmount);
    const delivered = inv.status === "sent";

    let daysOverdue = 0;
    if (remainingAmount > 0 && delivered && inv.due_date !== null) {
      daysOverdue = Math.max(0, daysBetween(inv.due_date, now));
    }

    if (remainingAmount > 0) {
      openAmount = round2(openAmount + remainingAmount);
      addToBucket(buckets, daysOverdue, remainingAmount);
      if (daysOverdue > 0) {
        overdueAmount = round2(overdueAmount + remainingAmount);
        oldestOverdueDays = Math.max(oldestOverdueDays, daysOverdue);
      }
    }

    invoices.push({
      invoiceId: inv.id,
      status: inv.status,
      delivered,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      issuedAt: inv.created_at,
      dueDate: inv.due_date,
      payableAmount: inv.payable_amount,
      paidAmount,
      remainingAmount,
      daysOverdue,
    });
  }

  return {
    accountId: account.id,
    companyName: account.company_name,
    contactEmail: account.contact_email,
    contactPhone: account.contact_phone,
    paymentTermDays: account.payment_term_days,
    overdueBlockDays: account.overdue_block_days,
    invoices,
    openAmount,
    overdueAmount,
    unbilledAmount: unbilledAmount(account.id),
    // Havuzda kalan para: musteri borcundan fazlasini odemis demektir.
    creditAmount: pool,
    oldestOverdueDays,
    buckets,
  };
}

/** Istasyondaki tum faturali hesaplarin yaslandirma tablosu; en riskli en ustte. */
export function stationAging(stationId: number, now = Date.now()): AccountReceivable[] {
  const accounts = db
    .prepare<[number], FleetAccountRow>(
      "SELECT * FROM fleet_accounts WHERE station_id = ? AND billing_type = 'postpaid' ORDER BY company_name"
    )
    .all(stationId);

  return accounts
    .map((a) => accountReceivable(a, now))
    .sort((a, b) => b.oldestOverdueDays - a.oldestOverdueDays || b.overdueAmount - a.overdueAmount);
}

/**
 * Yakit alimini engelleyen bir gecikme var mi?
 *
 * Kapali (NULL) olmasi VARSAYILANDIR ve bilinclidir: bu kontrol, gece 2'de yolda
 * kalan bir soforle sonuclanabilecek tek mekanizmadir. Acilmasi hesap bazinda ve
 * bir tolerans suresiyle birlikte, isletmenin bilincli karariyla olur.
 */
export function blockingOverdue(account: FleetAccountRow, now = Date.now()): { days: number; amount: number } | null {
  if (account.billing_type !== "postpaid" || account.overdue_block_days === null) return null;
  const ledger = accountReceivable(account, now);
  if (ledger.oldestOverdueDays < account.overdue_block_days || ledger.overdueAmount <= 0) return null;
  return { days: ledger.oldestOverdueDays, amount: ledger.overdueAmount };
}

function overdueAlarmType(accountId: number): string {
  return `fleet_overdue_${accountId}`;
}

/**
 * Vadesi gecmis alacaklari tarar; her hesap icin ACIK BIR ALARM tutar.
 *
 * Tekrar bildirim gondermemenin yolu ayri bir "gonderildi mi" kolonu degil, alarmin
 * kendisidir (dusuk bakiye uyarisiyla ayni desen, bkz. fleetService.checkLowBalance):
 * acik alarm varsa zaten haber verilmistir, borc kapaninca alarm cozulur ve hesap
 * yeniden gecikmeye duserse yeni bir alarm/bildirim uretilir.
 */
export function sweepOverdueReceivables(now = Date.now()): void {
  const accounts = db
    .prepare<[], FleetAccountRow>(
      "SELECT * FROM fleet_accounts WHERE billing_type = 'postpaid' AND payment_term_days IS NOT NULL"
    )
    .all();

  for (const account of accounts) {
    let ledger: AccountReceivable;
    try {
      ledger = accountReceivable(account, now);
    } catch (err) {
      logger.error({ err, accountId: account.id }, "Filo alacak defteri hesaplanamadi.");
      continue;
    }

    const alarmType = overdueAlarmType(account.id);

    if (ledger.overdueAmount <= 0) {
      const result = db
        .prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE station_id = ? AND type = ? AND status != 'resolved'")
        .run(new Date(now).toISOString(), account.station_id, alarmType);
      if (result.changes > 0) broadcastAlarms(account.station_id);
      continue;
    }

    const existing = db
      .prepare<[number, string], { id: number }>("SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1")
      .get(account.station_id, alarmType);
    if (existing) continue;

    const message =
      `${account.company_name} filo hesabinda vadesi gecmis ${ledger.overdueAmount.toFixed(2)} TL alacak var ` +
      `(en eski gecikme ${ledger.oldestOverdueDays} gun).`;
    createAlarm({ stationId: account.station_id, type: alarmType, severity: "critical", message });

    // Musteriye giden hatirlatma isletmenin alarmindan AYRI metindir: musteriye
    // "alacak" degil "vadesi gecen fatura" denir ve ne yapmasi gerektigi yazilir.
    const customerMessage =
      `${account.company_name} - vadesi gecen fatura hatirlatmasi: ${ledger.overdueAmount.toFixed(2)} TL tutarindaki ` +
      `odemeniz ${ledger.oldestOverdueDays} gundur beklemektedir. Odeme yaptiysaniz bu mesaji dikkate almayiniz.`;
    if (account.contact_email) {
      sendEmail(account.contact_email, `[Vadesi Gecen Fatura] ${account.company_name}`, customerMessage).catch((err) =>
        logger.error({ err, accountId: account.id }, "Vadesi gecen fatura e-postasi gonderilemedi.")
      );
    }
    if (account.contact_phone) {
      sendSms(account.contact_phone, customerMessage).catch((err) =>
        logger.error({ err, accountId: account.id }, "Vadesi gecen fatura SMS'i gonderilemedi.")
      );
    }
  }
}
