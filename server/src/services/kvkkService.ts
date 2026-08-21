import { db } from "../db/index.js";

export class KvkkError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/\s+/g, " ").trim();
}

interface PersonalTransaction {
  id: number;
  fuelType: string;
  dispensedLiters: number;
  totalAmount: number;
  paymentMethod: string;
  status: string;
  receiptEmail: string | null;
  receiptPhone: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface PersonalLoyaltyMovement {
  id: number;
  type: string;
  points: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export interface PersonalDataReport {
  plate: string;
  transactions: PersonalTransaction[];
  loyalty: { points: number; movements: PersonalLoyaltyMovement[] } | null;
  fleetLinked: boolean;
}

function findFleetLink(stationId: number, plate: string): boolean {
  const row = db
    .prepare<[number, string], { id: number }>(
      `SELECT fp.id FROM fleet_plates fp
       JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
       WHERE fa.station_id = ? AND fp.plate = ?`
    )
    .get(stationId, plate);
  return !!row;
}

export function lookupPersonalData(stationId: number, plateInput: string): PersonalDataReport {
  const plate = normalizePlate(plateInput);
  if (!plate) throw new KvkkError("Gecerli bir plaka giriniz.", 400);

  const transactions = db
    .prepare<[number, string], PersonalTransaction & { dispensed_liters: number; total_amount: number; payment_method: string; receipt_email: string | null; receipt_phone: string | null; started_at: string; completed_at: string | null; fuel_type: string }>(
      `SELECT id, fuel_type, dispensed_liters, total_amount, payment_method, status, receipt_email, receipt_phone, started_at, completed_at
       FROM transactions WHERE station_id = ? AND plate = ? ORDER BY started_at DESC`
    )
    .all(stationId, plate)
    .map((t) => ({
      id: t.id,
      fuelType: t.fuel_type,
      dispensedLiters: t.dispensed_liters,
      totalAmount: t.total_amount,
      paymentMethod: t.payment_method,
      status: t.status,
      receiptEmail: t.receipt_email,
      receiptPhone: t.receipt_phone,
      startedAt: t.started_at,
      completedAt: t.completed_at,
    }));

  const account = db
    .prepare<[number, string], { points: number }>("SELECT points FROM loyalty_accounts WHERE station_id = ? AND plate = ?")
    .get(stationId, plate);

  const loyalty = account
    ? {
        points: account.points,
        movements: db
          .prepare<[number, string], { id: number; type: string; points: number; balance_after: number; note: string | null; created_at: string }>(
            `SELECT id, type, points, balance_after, note, created_at FROM loyalty_movements
             WHERE station_id = ? AND plate = ? ORDER BY created_at DESC`
          )
          .all(stationId, plate)
          .map((m) => ({ id: m.id, type: m.type, points: m.points, balanceAfter: m.balance_after, note: m.note, createdAt: m.created_at })),
      }
    : null;

  return { plate, transactions, loyalty, fleetLinked: findFleetLink(stationId, plate) };
}

export interface ErasureResult {
  plate: string;
  transactionsAnonymized: number;
  loyaltyAccountDeleted: boolean;
  loyaltyMovementsAnonymized: number;
}

const ANONYMIZED_PLATE = "[SILINDI]";

/**
 * KVKK unutulma hakki talebi: kisisel tanimlayicilari (plaka, e-posta, telefon) kaldirir,
 * ancak mali/vergisel saklama yukumlulugu nedeniyle islem tutar/tarih kayitlarini korur
 * (bkz. stations.ts istasyon silme - ayni "anonimize et, tamamen silme" yaklasimi).
 */
export function eraseByPlate(stationId: number, plateInput: string): ErasureResult {
  const plate = normalizePlate(plateInput);
  if (!plate) throw new KvkkError("Gecerli bir plaka giriniz.", 400);
  if (plate === ANONYMIZED_PLATE) throw new KvkkError("Bu plaka zaten anonimlestirilmis.", 409);

  if (findFleetLink(stationId, plate)) {
    throw new KvkkError(
      "Bu plaka bir filo hesabina bagli; once Filo Hesaplari sayfasindan hesaptan cikarilmasi gerekiyor.",
      409
    );
  }

  const erase = db.transaction(() => {
    const txResult = db
      .prepare("UPDATE transactions SET plate = ?, receipt_email = NULL, receipt_phone = NULL WHERE station_id = ? AND plate = ?")
      .run(ANONYMIZED_PLATE, stationId, plate);

    const loyaltyDeleted = db.prepare("DELETE FROM loyalty_accounts WHERE station_id = ? AND plate = ?").run(stationId, plate);

    const movementsResult = db
      .prepare("UPDATE loyalty_movements SET plate = ? WHERE station_id = ? AND plate = ?")
      .run(ANONYMIZED_PLATE, stationId, plate);

    return {
      transactionsAnonymized: txResult.changes,
      loyaltyAccountDeleted: loyaltyDeleted.changes > 0,
      loyaltyMovementsAnonymized: movementsResult.changes,
    };
  });

  const result = erase();
  return { plate, ...result };
}
