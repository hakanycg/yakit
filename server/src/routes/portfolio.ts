import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import { getPortfolioReport } from "../services/portfolioService.js";
import { businessDateDaysAgo, currentBusinessDate } from "../utils/businessDay.js";
import { csvEscape } from "../utils/csv.js";

/**
 * Konsolide (cok istasyonlu) rapor.
 *
 * /api/reports'un aksine TEK BIR ISTASYONA bagli degildir, bu yuzden ayri bir router:
 * reports router'i requireStationSelected uyguluyor ve bu ucun tam olarak o kisiti
 * asmasi gerekiyor.
 *
 * Istasyonlar arasi calistigi icin attachStationScope'un korumasinin disindadir ve
 * kiraci filtresini KENDISI uygular (bkz. middleware/tenantScope.ts'teki ayni desen):
 * platform yoneticisi hepsini gorur, dagitim sirketi yoneticisi yalnizca kendi
 * istasyonlarini. Tek istasyonlu roller bu uca ihtiyac duymaz - zaten tek istasyonlari
 * var - ve erisemez.
 */
const router = Router();
router.use(requireAuth, requireRole("super_admin", "tenant_admin"));

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biciminde olmalidir.");

const querySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

function resolveRange(q: z.infer<typeof querySchema>): { from: string; to: string } {
  const to = q.to ?? currentBusinessDate();
  const from = q.from ?? businessDateDaysAgo(29);
  // Ters aralik sessizce bos sonuc dondururdu; kullanici tarihleri yanlis girdigini
  // anlamazdi. Duzeltmek yerine reddetmek daha durust: hangisini kastettigini bilemeyiz.
  return from > to ? { from: to, to: from } : { from, to };
}

router.get("/", validateQuery(querySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof querySchema> }).validatedQuery;
  const { from, to } = resolveRange(q);
  const report = getPortfolioReport({ tenantId: req.user!.tenant_id }, from, to);

  // Sayfalama yalnizca TABLO gorunumu icindir: toplamlar (totals) her zaman
  // TUM istasyonlar uzerinden hesaplanmis kalir - aksi halde sayfa 2'ye
  // gecince "Toplam ciro" karti yanlislikla sadece o sayfayi yansitirdi.
  const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  const total = report.stations.length;
  const start = (page - 1) * pageSize;
  const pagedReport = { ...report, stations: report.stations.slice(start, start + pageSize) };

  res.json({ report: pagedReport, total, page, pageSize });
});

router.get("/export.csv", validateQuery(querySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof querySchema> }).validatedQuery;
  const { from, to } = resolveRange(q);
  const report = getPortfolioReport({ tenantId: req.user!.tenant_id }, from, to);

  const header = [
    "istasyon",
    "kod",
    "durum",
    "islem",
    "ciro",
    "indirim",
    "litre",
    "acik_alarm",
    "kritik_alarm",
    "acik_destek",
    "sapma_litre",
    "son_senkron",
  ];
  const lines = [header.join(",")];
  for (const s of report.stations) {
    lines.push(
      [
        s.stationName,
        s.stationCode,
        s.active === 1 ? "Aktif" : "Pasif",
        s.transactionCount,
        s.revenue,
        s.discount,
        s.liters,
        s.activeAlarms,
        s.criticalAlarms,
        s.openSupportRequests,
        s.varianceLiters,
        s.lastSyncedAt,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  recordAudit({
    user: req.user!,
    action: "portfolio_report_exported",
    details: { from, to, stationCount: report.stations.length },
    ip: req.ip,
    stationId: null,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="konsolide-rapor-${from}_${to}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

export const portfolioRouter = router;
