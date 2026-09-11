import { db } from "../db/index.js";
import type { LoyaltyReferralRow } from "../db/types.js";
import { normalizePlate } from "../utils/plate.js";
import { awardBonusPoints, getLoyaltyConfig } from "./loyaltyService.js";

/**
 * Referral (yonlendirme) programi: mevcut bir musteri (referrer) yeni bir musteriyi
 * (referred) getirirse, referred plaka bu istasyonda ILK dolumunu TAMAMLADIGINDA her
 * iki tarafa da bonus puan verilir.
 *
 * Akis: kiosk plaka adiminda musteri opsiyonel olarak "beni kim yonlendirdi" plakasini
 * girer (bkz. PlateStep.tsx) -> islem olusturulurken tryRegisterReferral() "pending" bir
 * kayit acar (bkz. transactionService.createTransaction) -> dolum TAMAMLANDIGINDA
 * completeReferral() cagrilir (bkz. transactionService.startDispensing, earnPoints ile
 * ayni yerde) ve gercekten bu plakanin ILK basarili islemi oldugu (registerReferral
 * zamaninda kontrol edilmis olsa da, arada baska bir islem tamamlanmis olabilir - ör.
 * ayni plaka baska bir pompada es zamanli islem yapmis olabilir) dogrulanip bonus verilir.
 */

function hasCompletedTransaction(stationId: number, plate: string, excludeTransactionId?: number): boolean {
  const params: unknown[] = [stationId, plate];
  let sql = "SELECT COUNT(*) as c FROM transactions WHERE station_id = ? AND plate = ? AND status = 'completed'";
  if (excludeTransactionId !== undefined) {
    sql += " AND id != ?";
    params.push(excludeTransactionId);
  }
  const row = db.prepare<unknown[], { c: number }>(sql).get(...params)!;
  return row.c > 0;
}

/**
 * Islem olusturulurken (henuz odeme/dolum yapilmadan) cagrilir - musterinin asil
 * amaci (yakit almak) BASARISIZ OLMAMALI diye asla hata firlatmaz; uygun degilse
 * sessizce null doner. Uygunluk: program acik, kendi kendini yonlendirmiyor, referred
 * plaka bu istasyonda daha once HIC tamamlanmis islemi yok ve daha once hic referred
 * olarak kaydedilmemis (UNIQUE(station_id, referred_plate)).
 */
export function tryRegisterReferral(stationId: number, referrerPlateRaw: string, referredPlateRaw: string): LoyaltyReferralRow | null {
  const config = getLoyaltyConfig(stationId);
  if (!config.enabled || !config.referralEnabled) return null;

  const referrerPlate = normalizePlate(referrerPlateRaw);
  const referredPlate = normalizePlate(referredPlateRaw);
  if (!referrerPlate || !referredPlate || referrerPlate === referredPlate) return null;
  if (hasCompletedTransaction(stationId, referredPlate)) return null;

  try {
    const result = db
      .prepare(
        `INSERT INTO loyalty_referrals (station_id, referrer_plate, referred_plate, status)
         VALUES (?, ?, ?, 'pending')`
      )
      .run(stationId, referrerPlate, referredPlate);
    return getReferralById(result.lastInsertRowid as number);
  } catch {
    // UNIQUE(station_id, referred_plate) ihlali: bu plaka daha once (baska bir referrer
    // tarafindan, ya da yarisan es zamanli bir istekle) zaten kaydedilmis - sessizce yoksay.
    return null;
  }
}

function getReferralById(id: number): LoyaltyReferralRow {
  return db.prepare<[number], LoyaltyReferralRow>("SELECT * FROM loyalty_referrals WHERE id = ?").get(id)!;
}

function getPendingReferral(stationId: number, referredPlate: string): LoyaltyReferralRow | undefined {
  return db
    .prepare<[number, string], LoyaltyReferralRow>(
      "SELECT * FROM loyalty_referrals WHERE station_id = ? AND referred_plate = ? AND status = 'pending'"
    )
    .get(stationId, referredPlate);
}

/**
 * Bir islem basariyla TAMAMLANDIGINDA cagrilir (bkz. transactionService.ts, earnPoints ile
 * ayni yerde). Bekleyen bir referral varsa VE bu gercekten plakanin (bu islem disinda)
 * ilk tamamlanmis islemiyse, her iki tarafa da bonus verilir ve kayit "completed" olarak
 * isaretlenir. Sessizce no-op doner - referral yoksa ya da uygunluk artik saglanmiyorsa
 * (ör. program bu arada kapatildi) islem akisini ETKILEMEZ.
 */
export function completeReferral(stationId: number, plate: string, transactionId: number): void {
  const normalized = normalizePlate(plate);
  const referral = getPendingReferral(stationId, normalized);
  if (!referral) return;

  const config = getLoyaltyConfig(stationId);
  if (!config.enabled || !config.referralEnabled) return;
  if (hasCompletedTransaction(stationId, normalized, transactionId)) return; // bu islem, plakanin ilk tamamlanan islemi degilmis

  const referrerBonus = awardBonusPoints(
    stationId,
    referral.referrer_plate,
    config.referralBonusPoints,
    "referral",
    `Referans bonusu: ${referral.referred_plate} plakasini yonlendirdiniz.`
  );
  const refereeBonus = awardBonusPoints(
    stationId,
    normalized,
    config.referralRefereeBonusPoints,
    "referral",
    `Hos geldiniz bonusu: ${referral.referrer_plate} tarafindan yonlendirildiniz.`,
    transactionId
  );

  db.prepare(
    `UPDATE loyalty_referrals
     SET status = 'completed', referrer_bonus_points = ?, referred_bonus_points = ?, transaction_id = ?, completed_at = ?
     WHERE id = ?`
  ).run(referrerBonus, refereeBonus, transactionId, new Date().toISOString(), referral.id);
}

export function listReferrals(stationId: number, filters: { plate?: string; limit?: number } = {}): LoyaltyReferralRow[] {
  const clauses = ["station_id = ?"];
  const params: unknown[] = [stationId];
  if (filters.plate) {
    const normalized = normalizePlate(filters.plate);
    clauses.push("(referrer_plate = ? OR referred_plate = ?)");
    params.push(normalized, normalized);
  }
  const limit = Math.min(filters.limit ?? 200, 1000);
  return db
    .prepare<unknown[], LoyaltyReferralRow>(
      `SELECT * FROM loyalty_referrals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params, limit);
}

export function serializeReferral(r: LoyaltyReferralRow) {
  return {
    id: r.id,
    referrerPlate: r.referrer_plate,
    referredPlate: r.referred_plate,
    status: r.status,
    referrerBonusPoints: r.referrer_bonus_points,
    referredBonusPoints: r.referred_bonus_points,
    transactionId: r.transaction_id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
