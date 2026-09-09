import { Router } from "express";
import { z } from "zod";
import { attachStationScope, requireAuth, requireRole, requireStationSelected, csrfProtection } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/auditService.js";
import {
  MarketingCampaignError,
  createAndSendCampaign,
  listCampaigns,
  previewSegment,
} from "../services/marketingCampaignService.js";
import type { MarketingCampaignRow } from "../db/types.js";

/**
 * Kampanya bildirimi yonetimi - bkz. marketingCampaignService.ts icindeki YASAL SINIR
 * yorumu (IYS entegrasyonu yok). Yalnizca yonetim rolleri gorebilir/gonderebilir.
 */

const ADMIN_ROLES = ["super_admin", "tenant_admin", "admin"] as const;

const router = Router();
router.use(requireAuth, requireRole(...ADMIN_ROLES), attachStationScope, requireStationSelected, csrfProtection);

const segmentSchema = z.object({
  channel: z.enum(["email", "sms"]),
  minDaysSinceVisit: z.coerce.number().int().positive().optional(),
  maxDaysSinceVisit: z.coerce.number().int().positive().optional(),
});

router.get("/segment-preview", validateQuery(segmentSchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof segmentSchema> }).validatedQuery;
  const count = previewSegment(req.stationId!, q.channel, { minDaysSinceVisit: q.minDaysSinceVisit, maxDaysSinceVisit: q.maxDaysSinceVisit });
  res.json({ count });
});

function serialize(row: MarketingCampaignRow) {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    message: row.message,
    minDaysSinceVisit: row.min_days_since_visit,
    maxDaysSinceVisit: row.max_days_since_visit,
    recipientCount: row.recipient_count,
    successCount: row.success_count,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/", validateQuery(listQuerySchema), (req, res) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof listQuerySchema> }).validatedQuery;
  const { campaigns, total } = listCampaigns(req.stationId!, q.limit ?? 50, q.offset ?? 0);
  res.json({ campaigns: campaigns.map(serialize), total });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel: z.enum(["email", "sms"]),
  message: z.string().trim().min(1).max(1000),
  minDaysSinceVisit: z.number().int().positive().optional(),
  maxDaysSinceVisit: z.number().int().positive().optional(),
});

router.post("/", validateBody(createSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  try {
    const campaign = await createAndSendCampaign(req.stationId!, body, req.user!);
    recordAudit({
      user: req.user!,
      action: "marketing_campaign_sent",
      entityType: "marketing_campaign",
      entityId: campaign.id,
      details: {
        channel: campaign.channel,
        recipientCount: campaign.recipient_count,
        successCount: campaign.success_count,
      },
      ip: req.ip,
      stationId: req.stationId,
    });
    res.status(201).json({ campaign: serialize(campaign) });
  } catch (err) {
    if (err instanceof MarketingCampaignError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
});

export { router as marketingCampaignsRouter };
