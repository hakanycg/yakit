import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  CENTRAL_API_URL: z.string().url(),
  STATION_SYNC_TOKEN: z
    .string()
    .min(10, "STATION_SYNC_TOKEN bos olamaz - admin panelindeki Senkronizasyon token'iyla ayni olmalidir."),
  PORT: z.coerce.number().int().positive().default(4500),
  LOCAL_DB_PATH: z.string().min(1).default("./data/agent.sqlite"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  OUTBOX_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  CACHE_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Ortam degiskenleri gecersiz:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
