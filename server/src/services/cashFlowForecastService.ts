import { listAccountsWithBalance } from "./cashAccountService.js";
import { getSupplierLedger } from "./supplierLedgerService.js";
import { stationAging } from "./fleetReceivableService.js";

/**
 * Nakit akisi tahmini (bkz. arastirma bulgusu: stok tarafinda "kac gun yeter"
 * hesaplaniyor ama nakit tarafinda karsiligi yok). Onumuzdeki gunler icin BEKLENEN
 * nakit pozisyonu projeksiyonu - yeni bir veri kaynagi DEGIL, zaten var olan uc
 * kaynagin birlestirilmesi:
 *
 *   - Baslangic bakiyesi: cashAccountService.listAccountsWithBalance (aktif kasa/banka
 *     hesaplari).
 *   - Beklenen GIRIS: fleetReceivableService.stationAging - faturali filo hesaplarinin
 *     ILETILMIS (delivered) ve VADESI TANIMLI faturalarinin kalan tutari, vade
 *     tarihine yerlestirilir. Iletilmemis/vadesiz faturalar DAHIL EDILMEZ (ayni
 *     gerekce: fleetReceivableService'teki "vadesi islemez" ilkesi).
 *   - Beklenen CIKIS: supplierLedgerService.getSupplierLedger - tedarikciye olan
 *     GUNCEL borc. Bu tutarin bir VADE TARIHI YOK (schema'da tutulmuyor - fleet
 *     alacaklarinin aksine), bu yuzden durustce "bugun itibariyle zaten odenmesi
 *     gereken" bir tutar olarak (0. gune) yerlestirilir, uydurma bir vade
 *     TAKDIR EDILMEZ.
 *
 * Personel avanslari (staff_advances) KASITLI OLARAK DISLANIR: bunlar zaten
 * GECMISTE odenmis paralardir (bir GELECEK cikis degil), sadece bordroya karsi
 * henuz KAPATILMAMISLARDIR - projeksiyona dahil etmek cift sayim olurdu.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CashFlowDayPoint {
  date: string;
  expectedInflow: number;
  expectedOutflow: number;
  projectedBalance: number;
}

export interface CashFlowForecast {
  startingBalance: number;
  /** Tedarikciye olan, vadesi tanimsiz oldugu icin ilk gune yerlestirilen guncel borc. */
  immediateSupplierDebt: number;
  days: CashFlowDayPoint[];
}

export function getCashFlowForecast(stationId: number, horizonDays = 30): CashFlowForecast {
  const startingBalance = round2(
    listAccountsWithBalance(stationId)
      .filter((a) => a.active)
      .reduce((sum, a) => sum + a.balance, 0)
  );

  const inflowByDate = new Map<string, number>();
  for (const account of stationAging(stationId)) {
    for (const inv of account.invoices) {
      if (inv.remainingAmount <= 0 || !inv.delivered || inv.dueDate === null) continue;
      const key = inv.dueDate.slice(0, 10);
      inflowByDate.set(key, round2((inflowByDate.get(key) ?? 0) + inv.remainingAmount));
    }
  }

  const immediateSupplierDebt = round2(
    getSupplierLedger(stationId).reduce((sum, e) => sum + Math.max(0, e.balance), 0)
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days: CashFlowDayPoint[] = [];
  let running = round2(startingBalance - immediateSupplierDebt);

  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    // Vadesi bu projeksiyon PENCERESI BASLAMADAN ONCE gecmis (zaten vadesi gecmis)
    // faturalar ilk gune (bugun) toplanir - "ne zaman gelecegi degil, geldiginde
    // ne kadar birikmis olacagi" sorusuna durust bir cevap.
    let inflow = inflowByDate.get(key) ?? 0;
    if (i === 0) {
      for (const [dateKey, amount] of inflowByDate) {
        if (dateKey < key) inflow = round2(inflow + amount);
      }
    }
    running = round2(running + inflow);
    days.push({
      date: key,
      expectedInflow: inflow,
      expectedOutflow: i === 0 ? immediateSupplierDebt : 0,
      projectedBalance: running,
    });
  }

  return { startingBalance, immediateSupplierDebt, days };
}
