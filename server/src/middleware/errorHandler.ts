import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";
import { recordSystemError } from "../services/systemErrorService.js";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Kaynak bulunamadi." });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path }, "Islenmeyen hata");
  // Loglamak yetmez: personelsiz istasyonda 500 alan musteri sikayet etmez, gider.
  // Hata kaydedilir ve esik asilirsa mevcut kritik alarm zincirine baglanir
  // (bkz. systemErrorService.ts). Bu cagri asla hata firlatmaz.
  recordSystemError({ kind: "request", path: req.path, error: err });
  if (res.headersSent) return;
  res.status(500).json({ error: "Sunucu hatasi olustu." });
}
