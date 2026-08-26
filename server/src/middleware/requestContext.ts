import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Istegi isleyen kod yigininin her yerinden erisilebilen "kim, nereden" baglami.
 *
 * Denetim kaydi (audit_log) 100'den fazla noktadan yaziliyor ve her biri IP'yi elle
 * tasimak zorundaydi; unutulan yerde kayit "kullanici bilinmiyor, IP yok" olarak
 * dusuyordu - yani denetim gunlugunun tek isini yapamiyordu. IP ve tarayici imzasi
 * artik burada, istegin basinda bir kez yakalanip AsyncLocalStorage ile tasiniyor:
 * recordAudit cagiran hicbir yerin bunlari ayrica gecirmesi gerekmiyor.
 *
 * Zamanlanmis isler (fiyat guncelleme, veri imha) bir istegin icinde calismadigi icin
 * baglam bos doner - orada kayit "sistem" aktoru olarak yazilir, bu dogru cevaptir.
 */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function attachRequestContext(req: Request, _res: Response, next: NextFunction): void {
  storage.run({ ip: req.ip ?? null, userAgent: req.header("user-agent") ?? null }, next);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
