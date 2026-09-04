import rateLimit from "express-rate-limit";

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Cok fazla giris denemesi. Lutfen daha sonra tekrar deneyin." },
});

export const passwordResetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Cok fazla sifre sifirlama denemesi. Lutfen daha sonra tekrar deneyin." },
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Istek limiti asildi. Lutfen yavaslayin." },
});

export const kioskRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Istek limiti asildi." },
});

// Tanker canli konum takibi: kimliksiz (yalnizca token korumali) tek yazma ucu -
// bkz. routes/tankerTracking.ts. Gercek kullanim (soforun cihazi birkac dakikada
// bir konum gonderir) cok altinda kalir; buradaki amac token'i kaba kuvvetle
// denemeyi (bkz. safeCompare) pahali kilmak.
export const tankerTrackingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Istek limiti asildi." },
});
