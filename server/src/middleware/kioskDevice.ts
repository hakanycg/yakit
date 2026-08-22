import type { NextFunction, Request, Response } from "express";
import { db } from "../db/index.js";
import type { StationKioskRow, StationRow } from "../db/types.js";
import { safeCompare } from "../utils/safeCompare.js";

/**
 * Kiosk uclari kimlik dogrulamasizdir (musteri pompada oturum acmaz). Bu, islem
 * BASLATAN uclarin internetten herkese acik olmasi demekti: adres tahmin edilmese
 * bile /api/kiosk/transactions yalnizca sirali bir `pumpId` istedigi icin
 * disaridan pompa rezerve edilebiliyordu.
 *
 * Cozum, adresi gizlemek degil CIHAZI dogrulamak: her fiziksel kiosk'un
 * (station_kiosks) bir device_token'i olur, kiosk uygulamasi bunu her istekte
 * `x-kiosk-device-token` basligiyla gonderir. Token dogruysa istek, o kiosk'un
 * BAGLI OLDUGU istasyona sabitlenir - baska bir istasyonun pompasi kullanilamaz.
 *
 * Geriye donuk uyum: stations.require_kiosk_token = 0 olan (token dagitilmadan
 * once kurulmus) istasyonlarda dogrulama atlanir; yonetici tokenleri dagitip
 * ayari acinca zorunlu hale gelir.
 */

declare module "express-serve-static-core" {
  interface Request {
    kioskDevice?: StationKioskRow;
    kioskStation?: StationRow;
  }
}

function findKioskByToken(token: string): StationKioskRow | undefined {
  // Tokenler benzersiz ve yuksek entropili; once dogrudan eslesme aranir, ardindan
  // bulunan kaydin tokeni sabit-zamanli karsilastirmayla tekrar dogrulanir.
  const row = db.prepare<[string], StationKioskRow>("SELECT * FROM station_kiosks WHERE device_token = ?").get(token);
  if (!row || !row.device_token || !safeCompare(row.device_token, token)) return undefined;
  return row;
}

function getStation(stationId: number): StationRow | undefined {
  return db.prepare<[number], StationRow>("SELECT * FROM stations WHERE id = ? AND active = 1").get(stationId);
}

/**
 * Istegi bir kiosk cihazina baglar. Token gonderilmisse her zaman dogrulanir
 * (gecersizse 401). Token yoksa yalnizca ilgili istasyon `require_kiosk_token`
 * ile zorunlu tutuyorsa reddedilir.
 */
export function attachKioskDevice(req: Request, res: Response, next: NextFunction): void {
  const token = req.header("x-kiosk-device-token")?.trim();
  if (token) {
    const kiosk = findKioskByToken(token);
    if (!kiosk) {
      res.status(401).json({ error: "Gecersiz kiosk cihaz tokeni." });
      return;
    }
    const station = getStation(kiosk.station_id);
    if (!station) {
      res.status(401).json({ error: "Kiosk'un bagli oldugu istasyon aktif degil." });
      return;
    }
    db.prepare("UPDATE station_kiosks SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), kiosk.id);
    req.kioskDevice = kiosk;
    req.kioskStation = station;
  }
  next();
}

/**
 * Cihaz dogrulamasini ZORUNLU kilar. Hangi istasyonun kuralinin gecerli olacagi
 * istegin hedefinden cikarilir (ör. pompanin istasyonu): boylece "token yok" ile
 * "token gerekmiyor" ayrimi, dogru istasyonun ayarina gore yapilir.
 */
export function requireKioskDevice(req: Request, res: Response, targetStationId: number): boolean {
  const target = getStation(targetStationId);
  if (!target) {
    res.status(404).json({ error: "Istasyon bulunamadi." });
    return false;
  }

  if (req.kioskDevice) {
    if (req.kioskDevice.station_id !== targetStationId) {
      res.status(403).json({ error: "Bu kiosk baska bir istasyona tanimli." });
      return false;
    }
    return true;
  }

  if (target.require_kiosk_token) {
    res.status(401).json({
      error: "Bu istasyon icin kiosk cihaz tokeni gerekiyor. Yonetim panelinden kiosk ekleyip cihaz adresini kullanin.",
    });
    return false;
  }
  return true;
}
