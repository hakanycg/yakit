import { db } from "../db/index.js";
import { logger } from "../utils/logger.js";
import { broadcastAlarms, createAlarm } from "./alarmService.js";

/**
 * Kiosk filosu: tum istasyonlardaki fiziksel kiosk bilgisayarlarinin saglik durumu.
 *
 * Yuzlerce kiosk isletirken "hangi ekran su an calismiyor" sorusunun tek tek istasyon
 * kartlarini acarak cevaplanmasi mumkun degil; bu servis o soruyu tek sorguda cevaplar
 * ve cevrimdisi kalan kiosk'lar icin alarm uretir.
 */

/**
 * Kiosk ekrani /api/kiosk/heartbeat'i bu araliktan cok daha sik (60 sn) cagirir.
 * Esigin genis tutulmasi bilincli: gecici bir internet kesintisi veya bir tarayici
 * yenilemesi hemen alarm uretmemeli, gercekten dusmus bir cihaz uretmeli.
 */
const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;
const OFFLINE_ALARM_TYPE = "kiosk_offline";

export type KioskHealthStatus = "online" | "offline" | "never_seen";

export interface KioskFleetRow {
  id: number;
  label: string;
  anydesk_id: string | null;
  station_id: number;
  station_name: string;
  station_code: string | null;
  station_active: number;
  last_seen_at: string | null;
  created_at: string;
  /** Kiosk'un bagli oldugu istasyonda acik olan kritik donanim alarmi sayisi. */
  station_fault_alarms: number;
}

export function kioskStatus(lastSeenAt: string | null, now = Date.now()): KioskHealthStatus {
  // Hic baglanmamis bir kiosk ariza degildir: kaydi acilmis ama kurulum adresi
  // henuz cihaza uygulanmamistir. Bunu "cevrimdisi" saymak, her yeni kayitta
  // yanlis alarm uretirdi.
  if (!lastSeenAt) return "never_seen";
  return now - new Date(lastSeenAt).getTime() > OFFLINE_THRESHOLD_MS ? "offline" : "online";
}

export function serializeKioskFleetRow(k: KioskFleetRow) {
  const status = kioskStatus(k.last_seen_at);
  return {
    id: k.id,
    label: k.label,
    anydeskId: k.anydesk_id,
    stationId: k.station_id,
    stationName: k.station_name,
    stationCode: k.station_code,
    stationActive: k.station_active === 1,
    lastSeenAt: k.last_seen_at,
    createdAt: k.created_at,
    status,
    offlineMinutes:
      status === "offline" && k.last_seen_at
        ? Math.floor((Date.now() - new Date(k.last_seen_at).getTime()) / 60000)
        : null,
    stationFaultAlarms: k.station_fault_alarms,
  };
}

/**
 * Tum kiosk'lar tek sorguda. Ariza alarmlari istasyon bazindadir (ajan olaylarinda
 * kiosk kimligi tasinmiyor), bu yuzden ayni istasyondaki her kiosk ayni sayiyi
 * gosterir - "bu istasyonda acik bir donanim arizasi var" anlaminda.
 */
export function listKioskFleet(tenantId?: number | null): KioskFleetRow[] {
  // tenantId verilirse yalnizca o dagitim sirketinin istasyonlarindaki kiosk'lar doner.
  // Bu uc tek bir istasyona degil "tum kiosk'larim"a baktigindan attachStationScope'un
  // korumasinin disindadir ve filtresini kendisi uygulamak zorundadir.
  const tenantFilter = tenantId != null ? "AND s.tenant_id = ?" : "";
  const params = tenantId != null ? [tenantId] : [];
  return db
    .prepare<number[], KioskFleetRow>(
      `SELECT
         k.id, k.label, k.anydesk_id, k.station_id, k.last_seen_at, k.created_at,
         s.name AS station_name, s.code AS station_code, s.active AS station_active,
         (SELECT COUNT(*) FROM alarms a
           WHERE a.station_id = k.station_id
             AND a.status = 'active'
             AND a.type IN ('printer_fault', 'okc_fault')) AS station_fault_alarms
       FROM station_kiosks k
       JOIN stations s ON s.id = k.station_id
       WHERE 1 = 1 ${tenantFilter}
       ORDER BY s.name ASC, k.id ASC`
    )
    .all(...params);
}

export interface KioskFleetSummary {
  total: number;
  online: number;
  offline: number;
  neverSeen: number;
  stationsWithFault: number;
}

export function summarizeKioskFleet(rows: KioskFleetRow[]): KioskFleetSummary {
  const summary: KioskFleetSummary = { total: rows.length, online: 0, offline: 0, neverSeen: 0, stationsWithFault: 0 };
  const faultStations = new Set<number>();
  for (const row of rows) {
    const status = kioskStatus(row.last_seen_at);
    if (status === "online") summary.online++;
    else if (status === "offline") summary.offline++;
    else summary.neverSeen++;
    if (row.station_fault_alarms > 0) faultStations.add(row.station_id);
  }
  summary.stationsWithFault = faultStations.size;
  return summary;
}

function activeOfflineAlarm(stationId: number, kioskId: number): { id: number } | undefined {
  // Alarm tablosunda kiosk kimligi icin ayri bir kolon yok; ayni istasyondaki farkli
  // kiosk'larin alarmlari mesaj icindeki "#<id>" ile ayrilir.
  return db
    .prepare<[number, string, string], { id: number }>(
      "SELECT id FROM alarms WHERE station_id = ? AND type = ? AND status = 'active' AND message LIKE ? LIMIT 1"
    )
    .get(stationId, OFFLINE_ALARM_TYPE, `%#${kioskId} %`);
}

/**
 * Cevrimdisi kalan kiosk'lar icin alarm acar, geri donenlerin alarmini kapatir.
 * Personelsiz istasyonda dusmus bir kiosk, o adada hic satis yapilamamasi demektir;
 * kimse fark etmeden saatlerce boyle kalabilir.
 */
export function checkOfflineKiosks(now = Date.now()): void {
  for (const kiosk of listKioskFleet()) {
    const status = kioskStatus(kiosk.last_seen_at, now);
    const existing = activeOfflineAlarm(kiosk.station_id, kiosk.id);

    // Pasif istasyonun kiosk'u kapali olmalidir zaten; alarm uretmek gurultu olur.
    if (status === "offline" && kiosk.station_active === 1) {
      if (existing) continue;
      const minutes = kiosk.last_seen_at
        ? Math.floor((now - new Date(kiosk.last_seen_at).getTime()) / 60000)
        : 0;
      try {
        createAlarm({
          stationId: kiosk.station_id,
          type: OFFLINE_ALARM_TYPE,
          severity: "warning",
          message: `Kiosk #${kiosk.id} (${kiosk.label}) ${minutes} dakikadir merkeze baglanamiyor. Ekran kapali, internet kesik veya tarayici cokmus olabilir; bu adada satis yapilamiyor.`,
        });
      } catch (err) {
        logger.error({ err, kioskId: kiosk.id }, "Kiosk cevrimdisi alarmi olusturulamadi.");
      }
      continue;
    }

    if (status === "online" && existing) {
      const result = db
        .prepare("UPDATE alarms SET status = 'resolved', resolved_at = ? WHERE id = ?")
        .run(new Date(now).toISOString(), existing.id);
      if (result.changes > 0) broadcastAlarms(kiosk.station_id);
    }
  }
}
