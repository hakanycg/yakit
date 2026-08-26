import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { recordAudit } from "./auditService.js";
import { logger } from "../utils/logger.js";

/**
 * KVKK saklama suresi - eski kisisel verinin otomatik anonimlestirilmesi.
 *
 * KVKK silme/erisim ekrani (kvkkService.ts) yalnizca TALEP UZERINE calisiyordu. Oysa
 * kanun, kisisel verinin "islendikleri amac icin gerekli olan sureden" uzun tutulmamasini
 * da ister - kimse talep etmese bile. Bugun girilen bir plaka, hicbir sey yapilmazsa
 * on yil sonra da veritabaninda durur.
 *
 * GERILIM: Vergi mevzuati (VUK/TTK) mali kaydin saklanmasini ZORUNLU kilar; KVKK kimligin
 * silinmesini ister. Ikisi celismez, cunku istedikleri sey ayni sey degildir:
 *
 *     PARAYI TUT, KIMLIGI DUSUR.
 *
 * Islem kaydi (tutar, litre, tarih, yakit tipi, odeme yontemi) oldugu gibi kalir; yalnizca
 * kisisel tanimlayicilar (plaka, makbuz e-postasi/telefonu) kaldirilir. Ayni yaklasim
 * kvkkService.eraseByPlate ve istasyon silmede de kullanilir.
 */

const ANONYMIZED_PLATE = "[SILINDI]";

/**
 * Varsayilan 24 ay. KVKK bir SAYI vermez - sureyi veri sorumlusu kendi saklama ve imha
 * politikasinda belirler. 24 ay, isletmenin yil-yila karsilastirma yapabilecegi kadar
 * uzun, "gerekli surenin otesinde" savunulamayacak kadar kisa bir baslangic noktasidir;
 * istasyon kendi politikasina gore degistirmelidir.
 */
const DEFAULT_RETENTION_MONTHS = 24;
const RETENTION_MONTHS_KEY = "kvkk_retention_months";
const ENABLED_KEY = "kvkk_retention_enabled";

export class DataRetentionError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface RetentionSettings {
  enabled: boolean;
  retentionMonths: number;
}

export function getRetentionSettings(stationId: number): RetentionSettings {
  const raw = getSetting(stationId, RETENTION_MONTHS_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return {
    // Varsayilan KAPALI: kisisel veriyi geri donulemez sekilde silen bir surecin, istasyon
    // kendi saklama politikasini belirlemeden kendiliginden calismaya baslamasi dogru olmaz.
    enabled: getSetting(stationId, ENABLED_KEY) === "true",
    retentionMonths: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_RETENTION_MONTHS,
  };
}

export function updateRetentionSettings(
  stationId: number,
  input: { enabled?: boolean; retentionMonths?: number },
  actor: UserRow
): RetentionSettings {
  if (input.retentionMonths !== undefined) {
    // Alt sinir 6 ay: daha kisa bir pencere, isletmenin kendi islem gecmisini
    // inceleyemez hale gelmesi demektir ve yanlislikla girilen bir "1" geri
    // donulemez bir veri kaybi olurdu.
    if (!Number.isFinite(input.retentionMonths) || input.retentionMonths < 6 || input.retentionMonths > 240) {
      throw new DataRetentionError("Saklama suresi 6 ile 240 ay arasinda olmalidir.", 400);
    }
    setSetting(stationId, RETENTION_MONTHS_KEY, String(input.retentionMonths), actor);
  }
  if (input.enabled !== undefined) {
    setSetting(stationId, ENABLED_KEY, input.enabled ? "true" : "false", actor);
  }
  return getRetentionSettings(stationId);
}

export interface RetentionSweepResult {
  stationId: number;
  cutoff: string;
  transactionsAnonymized: number;
  loyaltyMovementsAnonymized: number;
  dormantLoyaltyAccountsDeleted: number;
}

function cutoffFor(retentionMonths: number, now: Date): string {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return cutoff.toISOString();
}

/**
 * Bir istasyonun saklama penceresini uygular.
 *
 * Dokunulmayanlar:
 *  - Zaten anonimlestirilmis kayitlar (islem tekrar tekrar ayni satirlari saymasin).
 *  - FILO plakalari: aktif bir ticari sozlesmeye baglidirlar, yani isleme amaci hala
 *    devam ediyordur. Sozlesme bittiginde plaka hesaptan cikarilir ve bir sonraki
 *    pencerede dogal olarak kapsama girer.
 *  - Sadakat hesabi olan plakalarin GUNCEL hareketleri: musteri hala programin icindedir.
 *
 * Islemlerin plakasi anonimlestirildiginde sadakat hesabi ETKILENMEZ - ayri tablodadir ve
 * kendi bakiyesini korur. Bu bilincli: musterinin puani, iki yil onceki bir dolumun
 * plakasinin saklanmasina bagli degildir.
 */
export function sweepStation(stationId: number, now = new Date()): RetentionSweepResult | null {
  const settings = getRetentionSettings(stationId);
  if (!settings.enabled) return null;

  const cutoff = cutoffFor(settings.retentionMonths, now);

  const result = db.transaction(() => {
    const transactions = db
      .prepare(
        `UPDATE transactions
         SET plate = ?, receipt_email = NULL, receipt_phone = NULL
         WHERE station_id = ?
           AND COALESCE(completed_at, created_at) < ?
           AND plate != ?
           AND plate NOT IN (SELECT fp.plate FROM fleet_plates fp
                             JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
                             WHERE fa.station_id = ?)`
      )
      .run(ANONYMIZED_PLATE, stationId, cutoff, ANONYMIZED_PLATE, stationId);

    const movements = db
      .prepare(
        `UPDATE loyalty_movements SET plate = ?
         WHERE station_id = ? AND created_at < ? AND plate != ?`
      )
      .run(ANONYMIZED_PLATE, stationId, cutoff, ANONYMIZED_PLATE);

    // Atil sadakat hesabi: pencere boyunca hicbir hareketi olmamis. Kullanilmayan bir
    // hesabin plakasini tutmak, amaci kalmamis kisisel veri saklamaktir. Puani olan
    // hesaplara da uygulanir - hesap zaten atildir ve musteri isterse istasyona
    // basvurabilir; aksi halde "puani var" gerekcesiyle veri sonsuza kadar tutulurdu.
    const dormant = db
      .prepare(
        `DELETE FROM loyalty_accounts
         WHERE station_id = ? AND updated_at < ?
           AND plate NOT IN (SELECT plate FROM loyalty_movements WHERE station_id = ? AND created_at >= ?)`
      )
      .run(stationId, cutoff, stationId, cutoff);

    return {
      transactionsAnonymized: transactions.changes,
      loyaltyMovementsAnonymized: movements.changes,
      dormantLoyaltyAccountsDeleted: dormant.changes,
    };
  })();

  return { stationId, cutoff, ...result };
}

/**
 * Tum aktif istasyonlar icin calisir (bkz. index.ts). Her istasyonun kendi saklama
 * politikasi vardir; biri hata verse bile digerleri islenmeye devam eder.
 *
 * Sonuc DENETIM IZINE yazilir: KVKK uyumu "yapiyoruz" demek degil, yaptigini
 * GOSTEREBILMEKTIR - imha islemlerinin kayit altina alinmasi zaten mevzuatin bekledigi
 * seydir.
 */
export function sweepDataRetention(now = new Date()): RetentionSweepResult[] {
  const stations = db.prepare<[], { id: number }>("SELECT id FROM stations WHERE active = 1").all();
  const results: RetentionSweepResult[] = [];

  for (const station of stations) {
    try {
      const result = sweepStation(station.id, now);
      if (!result) continue;
      results.push(result);

      const total =
        result.transactionsAnonymized + result.loyaltyMovementsAnonymized + result.dormantLoyaltyAccountsDeleted;
      if (total > 0) {
        logger.info({ ...result }, "KVKK saklama suresi uygulandi.");
        recordAudit({
          user: null,
          actorType: "system",
          actorLabel: "KVKK saklama süresi işi",
          action: "kvkk_retention_applied",
          details: result,
          stationId: station.id,
        });
      }
    } catch (err) {
      logger.error({ err, stationId: station.id }, "KVKK saklama suresi uygulanamadi.");
    }
  }

  return results;
}

export interface RetentionPreview {
  cutoff: string;
  transactions: number;
  loyaltyMovements: number;
  dormantLoyaltyAccounts: number;
}

/**
 * Onizleme: ayar acilmadan once "bu ne kadar veriyi etkiler" sorusunun cevabi. Geri
 * donulemez bir islemi once gostermeden calistirmak dogru olmaz.
 */
export function previewRetention(stationId: number, now = new Date()): RetentionPreview {
  const settings = getRetentionSettings(stationId);
  const cutoff = cutoffFor(settings.retentionMonths, now);

  const transactions = db
    .prepare<[number, string, string, number], { c: number }>(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE station_id = ? AND COALESCE(completed_at, created_at) < ? AND plate != ?
         AND plate NOT IN (SELECT fp.plate FROM fleet_plates fp
                           JOIN fleet_accounts fa ON fa.id = fp.fleet_account_id
                           WHERE fa.station_id = ?)`
    )
    .get(stationId, cutoff, ANONYMIZED_PLATE, stationId)!.c;

  const loyaltyMovements = db
    .prepare<[number, string, string], { c: number }>(
      "SELECT COUNT(*) AS c FROM loyalty_movements WHERE station_id = ? AND created_at < ? AND plate != ?"
    )
    .get(stationId, cutoff, ANONYMIZED_PLATE)!.c;

  const dormantLoyaltyAccounts = db
    .prepare<[number, string, number, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM loyalty_accounts
       WHERE station_id = ? AND updated_at < ?
         AND plate NOT IN (SELECT plate FROM loyalty_movements WHERE station_id = ? AND created_at >= ?)`
    )
    .get(stationId, cutoff, stationId, cutoff)!.c;

  return { cutoff, transactions, loyaltyMovements, dormantLoyaltyAccounts };
}
