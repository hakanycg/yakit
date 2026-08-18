import "dotenv/config";
import { z } from "zod";

/** Bos string'i (".env" dosyasinda bos birakilan opsiyonel degiskenler) undefined'a cevirir. */
const optionalString = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_PATH: z.string().min(1).default("./data/yakit.sqlite"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET en az 32 karakter olmalidir. `openssl rand -hex 32` ile uretebilirsiniz."),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SEED_ADMIN_USERNAME: z.string().min(3).default("admin"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe!12345"),

  // E-posta (SMTP) - bos birakilirsa e-posta gonderimi devre disi kalir, hata vermez.
  SMTP_HOST: optionalString(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: optionalString(),
  SMTP_PASS: optionalString(),
  SMTP_FROM: z.string().default("Yakit Istasyonu <no-reply@yakit-istasyonu.local>"),

  // SMS - genel bir HTTP tabanli SMS saglayicisina POST atar. Bos birakilirsa devre disi kalir.
  SMS_PROVIDER_URL: optionalUrl(),
  SMS_PROVIDER_API_KEY: optionalString(),
  SMS_SENDER_ID: z.string().default("YAKITIST"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Ortam degiskenleri gecersiz:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === "production";
