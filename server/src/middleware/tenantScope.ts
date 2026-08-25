import type { Request, Response } from "express";
import { db } from "../db/index.js";

/**
 * Istasyonlar ARASI calisan uclar icin kiraci filtresi.
 *
 * Istasyona bagli veri rotalarda req.stationId uzerinden akiyor ve o kapi
 * attachStationScope'ta tutuluyor (bkz. middleware/auth.ts). Ama bazi uclar tek bir
 * istasyona degil, "tum istasyonlarim"a bakar - istasyon listesi, kiosk filosu,
 * kullanici yonetimi. Bu uclar attachStationScope'un korumasinin DISINDA kalir ve
 * kendi filtresini uygulamak zorundadir; bu dosya o filtreyi tek yerde toplar.
 */

/**
 * Bir kullanicinin gorebilecegi istasyonlari sinirlayan SQL parcasi.
 *
 * super_admin icin kisit yoktur; tenant_admin yalnizca kendi kiracisinin
 * istasyonlarini gorur. Donen `sql` bir WHERE parcasidir ve `params` ona ait
 * baglantilardir - cagiran taraf kendi sorgusuna ekler.
 */
export function stationScopeFilter(req: Request, column = "station_id"): { sql: string; params: number[] } {
  if (req.role?.name === "tenant_admin" && req.user?.tenant_id !== null && req.user?.tenant_id !== undefined) {
    return {
      sql: `${column} IN (SELECT id FROM stations WHERE tenant_id = ?)`,
      params: [req.user.tenant_id],
    };
  }
  return { sql: "1 = 1", params: [] };
}

/**
 * Verilen istasyon, istegi yapanin erisim alaninda mi?
 *
 * Yol parametresinden (ör. /stations/:id) istasyon alan uclar icin; bu uclar
 * attachStationScope'un ?stationId= kontrolunden gecmez.
 */
export function canAccessStation(req: Request, stationId: number): boolean {
  if (req.role?.name === "super_admin") return true;
  if (req.role?.name === "tenant_admin") {
    if (req.user?.tenant_id === null || req.user?.tenant_id === undefined) return false;
    const row = db
      .prepare<[number, number], { id: number }>("SELECT id FROM stations WHERE id = ? AND tenant_id = ?")
      .get(stationId, req.user.tenant_id);
    return row !== undefined;
  }
  return req.user?.station_id === stationId;
}

/** canAccessStation'in hazir cevap veren hali; false donerse cevap zaten yazilmistir. */
export function requireStationAccess(req: Request, res: Response, stationId: number): boolean {
  if (canAccessStation(req, stationId)) return true;
  // Var olmayan ve erisilemeyen istasyon ayni cevabi alir: hangi id'lerin var oldugu
  // sizdirilmaz.
  res.status(403).json({ error: "Bu istasyona erisim yetkiniz yok." });
  return false;
}
