import "dotenv/config";
import { z } from "zod";

/** Bos string'i (".env" dosyasinda bos birakilan opsiyonel degiskenler) undefined'a cevirir. */
const optionalString = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());
/** Arsiv saklama sureleri: bos birakilabilir, verilirse pozitif tam sayi ay olmalidir.
 * Alt sinir burada DEGIL archiveService.ts'te (tablo basina farkli) uygulanir. */
const optionalMonths = () =>
  z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().int().positive().optional());

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

  // Bu sunucunun disaridan (iyzico'nun sunuculari dahil) erisilebilir oldugu genel adres.
  // iyzico odeme sonucu callback'i icin gereklidir; yerelde (localhost) calismaz.
  PUBLIC_API_BASE_URL: optionalUrl(),

  // Veritabani yedekleme - bos birakilirsa (varsayilan) devre disi kalir. Ayarlanirsa,
  // belirtilen dizine periyodik olarak tutarli (WAL-safe) bir SQLite yedegi alinir.
  BACKUP_DIR: optionalString(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  BACKUP_RETENTION_COUNT: z.coerce.number().int().positive().default(14),

  // Arsivleme (bkz. services/archiveService.ts) - bos birakilirsa (varsayilan) devre disi
  // kalir ve HICBIR SATIR SILINMEZ. Ayarlanirsa, esikten eski denetim kaydi/olcum satirlari
  // bu dizine sifreli NDJSON.gz olarak tasinir.
  //
  // DIKKAT: buradaki dosyalar yedeklerin aksine ROTASYONA TABI DEGILDIR - her biri artik
  // canli veritabaninda olmayan satirlarin TEK kopyasidir. Dizin kalici ve yedeklenen bir
  // depolamada olmalidir.
  ARCHIVE_DIR: optionalString(),
  ARCHIVE_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  // Tablo basina saklama suresi (ay). Bos birakilirsa archiveService.ts'teki varsayilanlar
  // kullanilir; tabanin altindaki degerler reddedilmez, tabana cekilir.
  ARCHIVE_AUDIT_LOG_MONTHS: optionalMonths(),
  ARCHIVE_TANK_READING_MONTHS: optionalMonths(),
  ARCHIVE_SYNC_EVENT_MONTHS: optionalMonths(),

  // iyzico/Uyumsoft API anahtarlarini veritabaninda sifrelemek icin kullanilan anahtar
  // (bkz. utils/secretsCrypto.ts). Opsiyoneldir - bos birakilirsa SESSION_SECRET'tan
  // turetilir, boylece mevcut dagitimlarda yeni bir zorunlu degisken eklemeden
  // sifreleme otomatik calisir. Ayri bir anahtar rotasyonu isteniyorsa
  // `openssl rand -hex 32` ile ayarlanabilir.
  SETTINGS_ENCRYPTION_KEY: optionalString(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Ortam degiskenleri gecersiz:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === "production";
