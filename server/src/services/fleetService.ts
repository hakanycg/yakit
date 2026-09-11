import { db } from "../db/index.js";
import type { FleetAccountRow, FleetMovementRow, FleetPlateRow, FuelType, UserRow } from "../db/types.js";
import { createAlarm, broadcastAlarms } from "./alarmService.js";
import { blockingOverdue } from "./fleetReceivableService.js";
import { sendEmail, sendSms } from "./notificationService.js";
import { logger } from "../utils/logger.js";
import { normalizePlate } from "../utils/plate.js";

export class FleetError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function listAccounts(stationId: number): FleetAccountRow[] {
  return db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE station_id = ? ORDER BY company_name").all(stationId);
}

export function getAccountById(stationId: number, id: number): FleetAccountRow {
  const row = db.prepare<[number, number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ? AND station_id = ?").get(id, stationId);
  if (!row) throw new FleetError("Filo hesabi bulunamadi.", 404);
  return row;
}

/** Kiosk'ta odeme secenegi olarak gosterilecek: bu plaka aktif bir filo hesabina bagliysa hesabi doner. */
export function getAccountForPlate(stationId: number, plate: string): FleetAccountRow | null {
  const row = db
    .prepare<[number, string], FleetAccountRow>(
      `SELECT fa.* FROM fleet_accounts fa
       JOIN fleet_plates fp ON fp.fleet_account_id = fa.id
       WHERE fa.station_id = ? AND fp.plate = ? AND fa.active = 1`
    )
    .get(stationId, normalizePlate(plate));
  return row ?? null;
}

export function listPlates(accountId: number): FleetPlateRow[] {
  return db.prepare<[number], FleetPlateRow>("SELECT * FROM fleet_plates WHERE fleet_account_id = ? ORDER BY created_at DESC").all(accountId);
}

/**
 * Yanlis yakit onleme icin: bu plakanin filo kaydinda beklenen yakit turu tanimliysa
 * doner - transactionService.getLastFuelTypeForPlate'in aksine, bu istasyonda hic
 * gecmisi olmayan (ILK ziyaret) bir araç icin de calisir.
 */
export function getExpectedFuelTypeForPlate(stationId: number, plate: string): FuelType | null {
  const row = db
    .prepare<[number, string], { expected_fuel_type: FuelType | null }>(
      `SELECT fp.expected_fuel_type FROM fleet_plates fp
       JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
       WHERE fa.station_id = ? AND fp.plate = ? AND fa.active = 1 AND fp.expected_fuel_type IS NOT NULL`
    )
    .get(stationId, normalizePlate(plate));
  return row?.expected_fuel_type ?? null;
}

/**
 * Bu plakanin bu istasyonda km girilerek tamamlanmis en SON dolumundaki km okumasi
 * (bkz. kiosk/steps/PaymentStep.tsx FleetChoicePanel) - soforun kiosk'a yanlislikla
 * eksik/fazla haneli bir sayi girmesini (ör. 123456 yerine 12345) yakalamak icin.
 * Sert bir engelleme DEGIL - bu bir UYARI: gercek bir arac degisimi/km sayaci
 * degisimi de ayni belirtiyi verir, o yuzden odemeyi durdurmaz.
 */
export function getLastOdometerForPlate(stationId: number, plate: string): number | null {
  const row = db
    .prepare<[number, string], { odometer_km: number }>(
      `SELECT odometer_km FROM transactions
       WHERE station_id = ? AND plate = ? AND status = 'completed' AND odometer_km IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`
    )
    .get(stationId, normalizePlate(plate));
  return row?.odometer_km ?? null;
}

export interface CreateFleetAccountInput {
  companyName: string;
  vkn?: string;
  billingType: "prepaid" | "postpaid";
  creditLimit?: number;
  contactEmail?: string;
  contactPhone?: string;
  lowBalanceThreshold?: number;
  paymentTermDays?: number;
  overdueBlockDays?: number;
}

export function createAccount(stationId: number, input: CreateFleetAccountInput, actor: UserRow): FleetAccountRow {
  const result = db
    .prepare(
      `INSERT INTO fleet_accounts (station_id, company_name, vkn, billing_type, credit_limit, contact_email, contact_phone,
                                   low_balance_threshold, payment_term_days, overdue_block_days, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stationId,
      input.companyName.trim(),
      input.vkn?.trim() || null,
      input.billingType,
      input.creditLimit ?? null,
      input.contactEmail?.trim() || null,
      input.contactPhone?.trim() || null,
      input.lowBalanceThreshold ?? null,
      input.paymentTermDays ?? null,
      input.overdueBlockDays ?? null,
      actor.id
    );
  return getAccountById(stationId, result.lastInsertRowid as number);
}

export interface UpdateFleetContactInput {
  contactEmail?: string | null;
  contactPhone?: string | null;
  lowBalanceThreshold?: number | null;
  paymentTermDays?: number | null;
  overdueBlockDays?: number | null;
}

/** Uyari/alacak takibi ayarlari: iletisim bilgileri, dusuk bakiye esigi, vade ve gecikme toleransi. */
export function updateContact(stationId: number, id: number, input: UpdateFleetContactInput): FleetAccountRow {
  getAccountById(stationId, id);
  const fields: string[] = [];
  const values: unknown[] = [];
  if ("contactEmail" in input) { fields.push("contact_email = ?"); values.push(input.contactEmail?.trim() || null); }
  if ("contactPhone" in input) { fields.push("contact_phone = ?"); values.push(input.contactPhone?.trim() || null); }
  if ("lowBalanceThreshold" in input) { fields.push("low_balance_threshold = ?"); values.push(input.lowBalanceThreshold ?? null); }
  if ("paymentTermDays" in input) { fields.push("payment_term_days = ?"); values.push(input.paymentTermDays ?? null); }
  if ("overdueBlockDays" in input) { fields.push("overdue_block_days = ?"); values.push(input.overdueBlockDays ?? null); }
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE fleet_accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }
  return getAccountById(stationId, id);
}

export interface DiscountAgreement {
  discountType: "percent" | "fixed" | null;
  discountValue: number | null;
}

/**
 * Filo hesabina bagli sabit anlasma indirimi - kurumsal musterilerle yapilan (ör.
 * "litre basina 0.50 TL indirim" veya "%3 indirim") ticari anlasmayi kayit altina
 * alir. discount_codes'taki percent/fixed deseniyle AYNI, ama musteri kod GIRMEZ:
 * plaka filo hesabina bagliysa ve filo ile odeme yapiliyorsa otomatik uygulanir
 * (bkz. transactionService.payWithFleetAccount, computeFleetDiscount).
 */
export function setDiscountAgreement(stationId: number, id: number, agreement: DiscountAgreement): FleetAccountRow {
  getAccountById(stationId, id);
  if (agreement.discountType !== null && (agreement.discountValue === null || agreement.discountValue <= 0)) {
    throw new FleetError("Indirim tipi secildiyse gecerli bir tutar/oran girilmelidir.", 400);
  }
  if (agreement.discountType === "percent" && agreement.discountValue !== null && agreement.discountValue > 100) {
    throw new FleetError("Yuzde indirim 100'den buyuk olamaz.", 400);
  }
  db.prepare("UPDATE fleet_accounts SET discount_type = ?, discount_value = ? WHERE id = ?").run(
    agreement.discountType,
    agreement.discountType === null ? null : agreement.discountValue,
    id
  );
  return getAccountById(stationId, id);
}

/**
 * Anlasma indirimini TL tutarina cevirir - discountService.validateCode'daki AYNI
 * percent/fixed hesabi (bkz. o dosyanin basindaki yorum), farkli kaynak: kod yerine
 * hesaba bagli sabit anlasma. totalAmount'i asamaz (Math.min ile sinirlanir).
 */
export function computeFleetDiscount(account: FleetAccountRow, totalAmount: number): number {
  if (!account.discount_type || !account.discount_value || totalAmount <= 0) return 0;
  const raw = account.discount_type === "percent" ? (totalAmount * account.discount_value) / 100 : account.discount_value;
  return Math.round(Math.min(raw, totalAmount) * 100) / 100;
}

export function setAccountActive(stationId: number, id: number, active: boolean): FleetAccountRow {
  const result = db.prepare("UPDATE fleet_accounts SET active = ? WHERE id = ? AND station_id = ?").run(active ? 1 : 0, id, stationId);
  if (result.changes === 0) throw new FleetError("Filo hesabi bulunamadi.", 404);
  return getAccountById(stationId, id);
}

export function addPlate(stationId: number, accountId: number, plate: string, expectedFuelType?: FuelType | null): FleetPlateRow {
  getAccountById(stationId, accountId);
  const normalized = normalizePlate(plate);
  try {
    const result = db
      .prepare("INSERT INTO fleet_plates (fleet_account_id, plate, expected_fuel_type) VALUES (?, ?, ?)")
      .run(accountId, normalized, expectedFuelType ?? null);
    return db.prepare<[number], FleetPlateRow>("SELECT * FROM fleet_plates WHERE id = ?").get(result.lastInsertRowid as number)!;
  } catch {
    throw new FleetError("Bu plaka zaten bu hesaba ekli.", 409);
  }
}

export function removePlate(stationId: number, accountId: number, plateId: number): void {
  getAccountById(stationId, accountId);
  const result = db.prepare("DELETE FROM fleet_plates WHERE id = ? AND fleet_account_id = ?").run(plateId, accountId);
  if (result.changes === 0) throw new FleetError("Plaka bulunamadi.", 404);
}

/**
 * Arac bazinda aylik harcama limiti - filo hesabinin GENEL bakiyesinden/kredi
 * limitinden AYRI bir koruma: hesabin kendisi yeterli bakiyeye/limite sahip olsa
 * bile, TEK bir arac/sofor o ayki payini asinca reddedilir. Boylece bir aracin
 * (ör. calinmis/kotuye kullanilan bir kart/plaka) butun filo bakiyesini tuketmesi
 * onlenir - diger araclarin o ay hala yakit alabilmesini garantiler.
 */
export function setPlateSpendingLimit(stationId: number, accountId: number, plateId: number, monthlyLimitTry: number | null): FleetPlateRow {
  getAccountById(stationId, accountId);
  if (monthlyLimitTry !== null && monthlyLimitTry <= 0) throw new FleetError("Harcama limiti pozitif bir tutar olmalidir.", 400);
  const result = db
    .prepare("UPDATE fleet_plates SET monthly_spending_limit_try = ? WHERE id = ? AND fleet_account_id = ?")
    .run(monthlyLimitTry, plateId, accountId);
  if (result.changes === 0) throw new FleetError("Plaka bulunamadi.", 404);
  return db.prepare<[number], FleetPlateRow>("SELECT * FROM fleet_plates WHERE id = ?").get(plateId)!;
}

function startOfCurrentMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Bu plakanin, ICINDE bulunulan takvim ayinda filo hesabindan tahsil edilmis toplam tutari (indirim dusulmus, net tahsilat). */
export function getMonthlySpendingForPlate(stationId: number, plate: string): number {
  const row = db
    .prepare<[number, string, string], { total: number | null }>(
      `SELECT SUM(total_amount - discount_amount) as total FROM transactions
       WHERE station_id = ? AND plate = ? AND payment_method = 'fleet' AND status = 'completed' AND created_at >= ?`
    )
    .get(stationId, normalizePlate(plate), startOfCurrentMonthIso());
  return Math.round((row?.total ?? 0) * 100) / 100;
}

/**
 * Bu plakanin ayni ay icinde, EKLENECEK tutarla birlikte kendi limitini asip
 * asmayacagini kontrol eder. Limit tanimli degilse (NULL) her zaman gecer.
 */
export function checkPlateSpendingLimit(stationId: number, plate: string, additionalAmount: number): void {
  const plateRow = db
    .prepare<[number, string], FleetPlateRow>(
      `SELECT fp.* FROM fleet_plates fp
       JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
       WHERE fa.station_id = ? AND fp.plate = ?`
    )
    .get(stationId, normalizePlate(plate));
  if (!plateRow || plateRow.monthly_spending_limit_try === null) return;

  const spentSoFar = getMonthlySpendingForPlate(stationId, plate);
  if (spentSoFar + additionalAmount > plateRow.monthly_spending_limit_try + 0.005) {
    throw new FleetError(
      `Bu aracin aylik harcama limiti (${plateRow.monthly_spending_limit_try.toFixed(2)} TL) bu islemle asilacak. Bu ay simdiye kadar ${spentSoFar.toFixed(2)} TL harcanmis.`,
      409
    );
  }
}

function insertMovement(params: {
  accountId: number;
  type: FleetMovementRow["type"];
  amount: number;
  balanceAfter: number;
  transactionId?: number | null;
  note?: string | null;
  userId?: number | null;
}): void {
  db.prepare(
    `INSERT INTO fleet_movements (fleet_account_id, type, amount, balance_after, transaction_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(params.accountId, params.type, params.amount, params.balanceAfter, params.transactionId ?? null, params.note ?? null, params.userId ?? null);
}

/**
 * Bakiye anlami odeme tipine gore degisir: on odemeli (prepaid) hesapta balance
 * HARCANABILIR bakiyedir (topup arttirir, charge dusurur); sonradan faturalandirma
 * (postpaid) hesapta balance HENUZ FATURALANMAMIS BORCTUR (charge arttirir, topup/
 * odeme kaydi dusurur). Her iki durumda da "kullanilabilir tutar" ayni kavrama
 * karsilik gelir - bkz. getAvailableAmount().
 */
export function getAvailableAmount(account: FleetAccountRow): number {
  if (account.billing_type === "prepaid") return account.balance;
  if (account.credit_limit === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, account.credit_limit - account.balance);
}

function fleetLowBalanceAlarmType(accountId: number): string {
  return `fleet_low_balance_${accountId}`;
}

/**
 * Prepaid bir hesabin bakiyesi esigin altina dusunce bir kez kritik alarm + (varsa)
 * dogrudan sirket yetkilisine e-posta/SMS gonderir - tekrar tekrar spam olmamasi icin
 * alarm zaten aktifse yeniden gonderilmez. Bakiye esigin uzerine cikinca (topup ile)
 * alarm otomatik cozulur, boylece bir sonraki dususte tekrar uyarabilir.
 */
function checkLowBalance(account: FleetAccountRow): void {
  if (account.billing_type !== "prepaid" || account.low_balance_threshold === null) return;
  const alarmType = fleetLowBalanceAlarmType(account.id);

  if (account.balance > account.low_balance_threshold) {
    const result = db
      .prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE station_id = ? AND type = ? AND status != 'resolved'")
      .run(new Date().toISOString(), account.station_id, alarmType);
    if (result.changes > 0) broadcastAlarms(account.station_id);
    return;
  }

  const existing = db
    .prepare<[number, string], { id: number }>("SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status != 'resolved' LIMIT 1")
    .get(account.station_id, alarmType);
  if (existing) return;

  const message = `${account.company_name} filo hesabinin bakiyesi dusuk (${account.balance.toFixed(2)} TL kaldi, esik: ${account.low_balance_threshold.toFixed(2)} TL).`;
  createAlarm({ stationId: account.station_id, type: alarmType, severity: "critical", message });

  if (account.contact_email) {
    sendEmail(account.contact_email, `[Dusuk Bakiye] ${account.company_name}`, message).catch((err) =>
      logger.error({ err, accountId: account.id }, "Filo dusuk bakiye e-postasi gonderilemedi.")
    );
  }
  if (account.contact_phone) {
    sendSms(account.contact_phone, message).catch((err) => logger.error({ err, accountId: account.id }, "Filo dusuk bakiye SMS'i gonderilemedi."));
  }
}

/** Yonetici/operator tarafindan bakiye yuklemesi (prepaid) veya borc kapama kaydi (postpaid). */
function applyTopUp(stationId: number, accountId: number, amount: number, note: string | undefined, userId: number | null): FleetAccountRow {
  if (amount <= 0) throw new FleetError("Gecersiz tutar.", 400);
  const account = getAccountById(stationId, accountId);
  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance + amount) * 100) / 100 : Math.max(0, Math.round((account.balance - amount) * 100) / 100);

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "topup", amount, balanceAfter: newBalance, note: note ?? null, userId });
  const updated = getAccountById(stationId, accountId);
  checkLowBalance(updated);
  return updated;
}

export function topUp(stationId: number, accountId: number, amount: number, note: string | undefined, actor: UserRow): FleetAccountRow {
  return applyTopUp(stationId, accountId, amount, note, actor.id);
}

/**
 * Personel onayi OLMADAN, dogrudan bir kart odemesi sonucunda bakiye yukler
 * (bkz. fleetCardTopupService.ts). user_id kasten NULL kalir - bunu yapan bir
 * personel degil, musterinin kendi kart odemesidir; movement gecmisinde "kim
 * yapti" sorusunun dogru cevabi budur.
 */
export function topUpFromCardPayment(stationId: number, accountId: number, amount: number, note: string): FleetAccountRow {
  return applyTopUp(stationId, accountId, amount, note, null);
}

/** Kiosk odemesinde filo hesabindan tahsilat yapar. Yetersiz bakiye/limit asimi durumunda hata firlatir. */
export function chargeAccount(stationId: number, accountId: number, amount: number, transactionId: number): FleetAccountRow {
  const account = getAccountById(stationId, accountId);
  if (!account.active) throw new FleetError("Filo hesabi aktif degil.", 409);

  // Vadesi gecmis alacak nedeniyle dondurulmus hesap. Bu kontrol VARSAYILAN OLARAK
  // KAPALIDIR (overdue_block_days NULL) ve hesap bazinda acilir - acildiginda gece 2'de
  // bir soforu yolda birakabilecek tek mekanizma budur, isletmenin bilincli karari olmali.
  // Hata mesaji tutari ve gun sayisini soyler: pompada "hesabiniz kapali" diye reddedilen
  // sofor, sirketini arayip ne olduğunu anlatabilmeli.
  const blocking = blockingOverdue(account);
  if (blocking) {
    throw new FleetError(
      `Filo hesabinda vadesi ${blocking.days} gun gecmis ${blocking.amount.toFixed(2)} TL odenmemis fatura var; yakit alimi durduruldu.`,
      409
    );
  }

  if (account.billing_type === "prepaid") {
    if (account.balance < amount) throw new FleetError("Filo hesabinda yetersiz bakiye.", 409);
  } else if (account.credit_limit !== null && account.balance + amount > account.credit_limit) {
    throw new FleetError("Filo hesabi kredi limiti asilir.", 409);
  }

  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance - amount) * 100) / 100 : Math.round((account.balance + amount) * 100) / 100;

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "charge", amount, balanceAfter: newBalance, transactionId });
  const updated = getAccountById(stationId, accountId);
  checkLowBalance(updated);
  return updated;
}

/** Odenmis ama hic yakit dagitilmadan iptal olan bir islemde tahsilati geri alir. */
export function refundCharge(stationId: number, accountId: number, amount: number, transactionId: number): void {
  if (amount <= 0) return;
  const account = getAccountById(stationId, accountId);
  const newBalance =
    account.billing_type === "prepaid" ? Math.round((account.balance + amount) * 100) / 100 : Math.max(0, Math.round((account.balance - amount) * 100) / 100);

  db.prepare("UPDATE fleet_accounts SET balance = ? WHERE id = ?").run(newBalance, accountId);
  insertMovement({ accountId, type: "refund", amount, balanceAfter: newBalance, transactionId, note: "Islem iptal/basarisiz oldugu icin tahsilat iadesi" });
}

/**
 * Bir islemin filo hesabindan GERCEKTE tahsil edilen tutarini geri ceker. Islemin
 * total_amount alanini degil, o tahsilata ait fleet_movements kaydini kaynak alir -
 * cunku dolum baslarken startDispensing() total_amount'u 0'a sifirlar (ilerleme
 * cubugu icin yeniden hesaplanir), yani islem uzerinden orijinal tahsilat tutarina
 * geri donup guvenilir sekilde ulasilamaz.
 */
export function refundChargeForTransaction(transactionId: number): void {
  const movement = db
    .prepare<[number], { fleet_account_id: number; amount: number }>(
      "SELECT fleet_account_id, amount FROM fleet_movements WHERE transaction_id = ? AND type = 'charge' ORDER BY id DESC LIMIT 1"
    )
    .get(transactionId);
  if (!movement) return;
  const account = db.prepare<[number], FleetAccountRow>("SELECT * FROM fleet_accounts WHERE id = ?").get(movement.fleet_account_id);
  if (!account) return;
  refundCharge(account.station_id, account.id, movement.amount, transactionId);
}

export function listMovements(stationId: number, accountId: number, limit = 200): (FleetMovementRow & { username: string | null })[] {
  getAccountById(stationId, accountId);
  return db
    .prepare<[number, number], FleetMovementRow & { username: string | null }>(
      `SELECT m.*, u.username as username
       FROM fleet_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.fleet_account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(accountId, Math.min(limit, 1000));
}

export function serializeAccount(a: FleetAccountRow) {
  return {
    id: a.id,
    companyName: a.company_name,
    vkn: a.vkn,
    billingType: a.billing_type,
    balance: a.balance,
    creditLimit: a.credit_limit,
    availableAmount: getAvailableAmount(a) === Number.POSITIVE_INFINITY ? null : getAvailableAmount(a),
    active: !!a.active,
    createdAt: a.created_at,
  };
}

/** Kiosk'a (public) degil, yalnizca admin panelindeki iletisim/uyari ayarlarina ozel alanlari ekler. */
export function serializeAccountAdmin(a: FleetAccountRow) {
  return {
    ...serializeAccount(a),
    contactEmail: a.contact_email,
    contactPhone: a.contact_phone,
    lowBalanceThreshold: a.low_balance_threshold,
    paymentTermDays: a.payment_term_days,
    overdueBlockDays: a.overdue_block_days,
    discountType: a.discount_type,
    discountValue: a.discount_value,
  };
}

export function serializePlate(p: FleetPlateRow, stationId?: number) {
  return {
    id: p.id,
    plate: p.plate,
    expectedFuelType: p.expected_fuel_type,
    createdAt: p.created_at,
    monthlySpendingLimitTry: p.monthly_spending_limit_try,
    // Yalnizca istasyon biliniyorsa hesaplanir (admin panelindeki plaka listesi) - kiosk'un
    // filo secimi gibi baska cagiranlar bu ek sorguyu ODEMEZ.
    monthlySpentTry: stationId !== undefined ? getMonthlySpendingForPlate(stationId, p.plate) : undefined,
  };
}

export function serializeMovement(m: FleetMovementRow & { username?: string | null }) {
  return {
    id: m.id,
    type: m.type,
    amount: m.amount,
    balanceAfter: m.balance_after,
    transactionId: m.transaction_id,
    note: m.note,
    username: m.username ?? null,
    createdAt: m.created_at,
  };
}
