import { db } from "../db/index.js";
import { sendEmail, sendSms, type SendResult } from "./notificationService.js";
import type { MarketingCampaignRow, UserRow } from "../db/types.js";

/**
 * Toplu pazarlama/kampanya bildirimi - sadakat sistemi (bkz. loyaltyService.ts) zaten
 * plaka bazinda musteri verisi topluyor ama istasyonun bu musterilere ULASMASI icin
 * hicbir yol yoktu. Bu servis o bosluu doldurur: bir SEGMENT (rizasi olan + son ziyaret
 * araligina uyan plakalar) secip mevcut e-posta/SMS kanallarindan (notificationService.ts)
 * toplu mesaj gonderir.
 *
 * YASAL SINIR (bilerek burada NET yazilir): Turkiye'de ticari elektronik ileti gonderimi
 * KVKK'nin yaninda ayrica Ileti Yonetim Sistemi (IYS) kaydi/kontrolu gerektirir (6563
 * sayili Kanun ve ilgili yonetmelik). Bu servis yalnizca KENDI riza kaydini (loyalty_accounts.
 * marketing_consent) tutar - IYS entegrasyonu YOKTUR. Gercek olcekte kullanmadan once
 * hukuk/uyum departmaniyla teyit edilmelidir (bkz. gorev listesindeki "Regulasyon: IYS
 * entegrasyonu" kaydi - filo iade faturasi/UTTS ile ayni turden bir dis-baglanti
 * kisitlamasi, kod yazarak cozulemez).
 */

export class MarketingCampaignError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface SegmentFilter {
  minDaysSinceVisit?: number;
  maxDaysSinceVisit?: number;
}

interface SegmentRecipient {
  plate: string;
  contact_email: string | null;
  contact_phone: string | null;
}

function segmentQuery(stationId: number, channel: "email" | "sms", filter: SegmentFilter): SegmentRecipient[] {
  const clauses = ["station_id = ?", "marketing_consent = 1"];
  const params: unknown[] = [stationId];
  clauses.push(channel === "email" ? "contact_email IS NOT NULL" : "contact_phone IS NOT NULL");

  // "minDaysSinceVisit": son ziyaretin uzerinden EN AZ bu kadar gun gecmis olsun
  // (ör. "30 gundur gelmeyenler") - updated_at bu kadar gunden ESKI olmali.
  if (filter.minDaysSinceVisit !== undefined) {
    clauses.push("updated_at <= ?");
    params.push(new Date(Date.now() - filter.minDaysSinceVisit * 24 * 60 * 60 * 1000).toISOString());
  }
  // "maxDaysSinceVisit": son ziyaret bu kadar gunden DAHA YENI olsun (ör. "bu hafta
  // gelenler") - updated_at bu tarihten sonra olmali.
  if (filter.maxDaysSinceVisit !== undefined) {
    clauses.push("updated_at >= ?");
    params.push(new Date(Date.now() - filter.maxDaysSinceVisit * 24 * 60 * 60 * 1000).toISOString());
  }

  return db
    .prepare<unknown[], SegmentRecipient>(`SELECT plate, contact_email, contact_phone FROM loyalty_accounts WHERE ${clauses.join(" AND ")}`)
    .all(...params);
}

export function previewSegment(stationId: number, channel: "email" | "sms", filter: SegmentFilter): number {
  return segmentQuery(stationId, channel, filter).length;
}

export function getCampaignById(id: number, stationId: number): MarketingCampaignRow {
  const row = db.prepare<[number], MarketingCampaignRow>("SELECT * FROM marketing_campaigns WHERE id = ?").get(id);
  if (!row || row.station_id !== stationId) throw new MarketingCampaignError("Kampanya bulunamadi.", 404);
  return row;
}

export interface ListCampaignsResult {
  campaigns: MarketingCampaignRow[];
  total: number;
}

export function listCampaigns(stationId: number, limit: number, offset: number): ListCampaignsResult {
  const campaigns = db
    .prepare<[number, number, number], MarketingCampaignRow>(
      "SELECT * FROM marketing_campaigns WHERE station_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(stationId, limit, offset);
  const { total } = db
    .prepare<[number], { total: number }>("SELECT COUNT(*) as total FROM marketing_campaigns WHERE station_id = ?")
    .get(stationId)!;
  return { campaigns, total };
}

export interface CreateCampaignInput {
  name: string;
  channel: "email" | "sms";
  message: string;
  minDaysSinceVisit?: number;
  maxDaysSinceVisit?: number;
}

const MAX_RECIPIENTS_PER_CAMPAIGN = 5000;

/**
 * Ayni anda en fazla bu kadar gonderim yapilir.
 *
 * MAX_RECIPIENTS_PER_CAMPAIGN kadar (5000) aliciyi TEK Promise.all() ile ayni anda
 * atesle mek SMTP sunucusunun/SMS saglayicisinin oran sinirini asip TUM kampanyanin
 * reddedilmesine (ya da hesabin gecici olarak kisitlanmasina) yol acabilir; ayrica
 * sunucuda ayni anda binlerce acik soket/istek biriktirir. Sabit boyutlu ardisik
 * pencerelerle gonderilir - saglayiciya nazik davranilir, kampanyanin tamami tek
 * seferde riske atilmaz.
 */
const SEND_CONCURRENCY = 20;

async function sendInBatches<T>(items: T[], size: number, send: (item: T) => Promise<SendResult>): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    results.push(...(await Promise.all(batch.map(send))));
  }
  return results;
}

/** Segmenti secip GERCEKTEN gonderir - kaydi olusturur, gonderimi yapar, sonuc sayaclarini yazar. */
export async function createAndSendCampaign(stationId: number, input: CreateCampaignInput, actor: UserRow): Promise<MarketingCampaignRow> {
  const name = input.name.trim();
  const message = input.message.trim();
  if (!name) throw new MarketingCampaignError("Kampanya adi gereklidir.", 400);
  if (!message) throw new MarketingCampaignError("Mesaj metni gereklidir.", 400);

  const filter: SegmentFilter = { minDaysSinceVisit: input.minDaysSinceVisit, maxDaysSinceVisit: input.maxDaysSinceVisit };
  const recipients = segmentQuery(stationId, input.channel, filter);
  if (recipients.length === 0) throw new MarketingCampaignError("Bu segmentte riza vermis musteri bulunamadi.", 400);
  if (recipients.length > MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw new MarketingCampaignError(`Tek kampanyada en fazla ${MAX_RECIPIENTS_PER_CAMPAIGN} aliciya gonderilebilir - segmenti daraltin.`, 400);
  }

  const insertResult = db
    .prepare(
      `INSERT INTO marketing_campaigns
        (station_id, name, channel, message, min_days_since_visit, max_days_since_visit, recipient_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(stationId, name, input.channel, message, input.minDaysSinceVisit ?? null, input.maxDaysSinceVisit ?? null, recipients.length, actor.id);
  const campaignId = insertResult.lastInsertRowid as number;

  const results = await sendInBatches(recipients, SEND_CONCURRENCY, (r) =>
    input.channel === "email" ? sendEmail(r.contact_email!, name, message) : sendSms(r.contact_phone!, message)
  );
  const successCount = results.filter((r) => r.sent).length;

  db.prepare("UPDATE marketing_campaigns SET success_count = ?, sent_at = ? WHERE id = ?").run(successCount, new Date().toISOString(), campaignId);

  return getCampaignById(campaignId, stationId);
}
