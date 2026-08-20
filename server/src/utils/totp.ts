import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP: verilen sayac degeri icin HMAC-SHA1 tabanli 6 haneli kod uretir. */
function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** Google Authenticator/Authy uyumlu, base32 kodlanmis rastgele 160 bit TOTP sirri uretir. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Authenticator uygulamasinin QR/manuel kurulum icin okuyacagi standart otpauth:// baglantisi. */
export function buildOtpauthUri(secret: string, accountLabel: string, issuer = "Yakit Istasyonu"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * otpauth:// baglantisini taranabilir bir QR kod resmine (PNG, data: URI) cevirir. Kullanicinin
 * anahtari elle girmesi gerekmesin diye - elle girise dayali kurulum bazi authenticator
 * uygulamalarinda "zaman tabanli / sayac tabanli" gibi gereksiz bir secim sorabiliyor; QR tarama
 * otpauth URI'daki `totp` tipini/algoritmayi/periyodu otomatik ve tartismasiz sekilde aktarir.
 */
export async function generateQrDataUrl(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
}

/** RFC 6238 TOTP: verilen zamana gore (varsayilan: simdi) 6 haneli dogrulama kodu uretir. Testler icin timeMs disaridan verilebilir. */
export function generateTotpCode(base32Secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Kullanicinin girdigi kodu dogrular. Saat kaymasi/girme gecikmesi icin +-1 adim (30sn)
 * tolerans taninir. Sabit-zamanli karsilastirma kullanilir (zamanlama sizintisini onlemek icin).
 */
export function verifyTotpCode(base32Secret: string, code: string, timeMs = Date.now(), window = 1): boolean {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return false;
  const secretBuf = base32Decode(base32Secret);
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  const candidateBuf = Buffer.from(normalized);

  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const expected = hotp(secretBuf, counter + errorWindow);
    if (timingSafeEqual(Buffer.from(expected), candidateBuf)) return true;
  }
  return false;
}
