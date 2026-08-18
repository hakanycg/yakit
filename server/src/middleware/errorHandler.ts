import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Kaynak bulunamadi." });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path }, "Islenmeyen hata");
  if (res.headersSent) return;
  res.status(500).json({ error: "Sunucu hatasi olustu." });
}
