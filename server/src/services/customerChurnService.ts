import { db } from "../db/index.js";

/**
 * Perakende musteri kaybi (churn) analizi (bkz. arastirma bulgusu: "sadakat programina
 * kayitli olmayan, siradan plakayla gelen TEKRAR musterilerin ziyaret sikligi, son
 * ziyaretten bu yana gecen sure hic izlenmiyor - erken kayip tespiti degerli olur").
 *
 * "Duzenli musteri" tanimi: son `lookbackDays` gun icinde en az `minVisits` kez
 * tamamlanmis islem yapmis bir plaka. Filo hesaplarina atanmis plakalar HARIC
 * TUTULUR - onlarin ziyaret paterni fleetConsumptionService.ts'te ayrica takip
 * ediliyor, buradaki soru ozellikle "sokaktan gelen" tekrar musteri icin.
 */

export interface ChurnRiskCustomer {
  plate: string;
  visitCount: number;
  lastVisitAt: string;
  daysSinceLastVisit: number;
}

export function getChurnRiskCustomers(
  stationId: number,
  opts: { minVisits?: number; inactiveDays?: number; lookbackDays?: number } = {}
): ChurnRiskCustomer[] {
  const minVisits = opts.minVisits ?? 3;
  const inactiveDays = opts.inactiveDays ?? 30;
  const lookbackDays = opts.lookbackDays ?? 365;

  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const rows = db
    .prepare<[number, string, number, number], { plate: string; visitCount: number; lastVisitAt: string }>(
      `SELECT plate,
              COUNT(*) as visitCount,
              MAX(COALESCE(completed_at, created_at)) as lastVisitAt
       FROM transactions
       WHERE station_id = ? AND status = 'completed' AND created_at >= ?
         -- Filo disi tutulan plakalar SADECE bu istasyonun filo hesaplarina bakilarak
         -- belirlenir - fleet_plates istasyona gore filtrelenmezse, plaka BASKA bir
         -- istasyonda filo araci diye burada da yanlislikla "filo" sayilir (ayni plaka
         -- bir istasyonda sadik perakende musteri, baskasinda filo araci olabilir).
         AND plate NOT IN (
           SELECT fp.plate FROM fleet_plates fp
           JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
           WHERE fa.station_id = ?
         )
       GROUP BY plate
       HAVING COUNT(*) >= ?`
    )
    .all(stationId, since, stationId, minVisits);

  const now = Date.now();
  const atRisk = rows
    .map((r) => ({
      plate: r.plate,
      visitCount: r.visitCount,
      lastVisitAt: r.lastVisitAt,
      daysSinceLastVisit: Math.floor((now - new Date(r.lastVisitAt).getTime()) / 86_400_000),
    }))
    .filter((r) => r.daysSinceLastVisit >= inactiveDays);

  // En degerli (en cok gelmis) musteri once, esitlikte en uzun suredir gelmeyen once -
  // bir isletme sahibinin once kimi arayacagini soran dogal siralama.
  return atRisk.sort((a, b) => b.visitCount - a.visitCount || b.daysSinceLastVisit - a.daysSinceLastVisit);
}
