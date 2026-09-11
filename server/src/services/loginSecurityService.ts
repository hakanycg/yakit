import { db } from "../db/index.js";
import type { UserRow } from "../db/types.js";
import { sendEmail } from "./notificationService.js";
import { enqueueWrite, registerWriteQueueHandler } from "./writeQueueService.js";

/**
 * Hesaba daha once GORULMEMIS bir IP adresinden giris yapildiginda kullaniciyi
 * bilgilendirir - calinmis bir sifreyle baska bir yerden yapilan girisin fark
 * edilmesini saglar. sessions tablosu bunun icin yeterli degil (bkz. schema.sql
 * known_login_ips yorumu): oturumlar suresi dolunca silinir, IP GECMISI kaybolur.
 *
 * Kullanicinin ILK GIRISINDE (henuz hic bilinen IP'si yokken) bildirim GONDERILMEZ -
 * o an her IP zaten "yeni"dir, bu suphe degil beklenen durumdur; yalnizca DAHA SONRA
 * eklenen yeni bir IP suphelidir.
 */

function hasAnyKnownIp(userId: number): boolean {
  return !!db.prepare("SELECT 1 FROM known_login_ips WHERE user_id = ? LIMIT 1").get(userId);
}

function isKnownIp(userId: number, ip: string): boolean {
  return !!db.prepare("SELECT 1 FROM known_login_ips WHERE user_id = ? AND ip_address = ?").get(userId, ip);
}

function recordLoginIp(userId: number, ip: string, userAgent: string | undefined): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO known_login_ips (user_id, ip_address, user_agent, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, ip_address) DO UPDATE SET last_seen_at = excluded.last_seen_at, user_agent = excluded.user_agent`
  ).run(userId, ip, userAgent ?? null, now, now);
}

/**
 * Basarili bir giristen sonra cagrilir (bkz. routes/auth.ts). IP bilinmiyorsa (ör. yerel
 * gelistirme, testler) hicbir sey yapmaz - alarm uretecek bir bilgi yok demektir.
 */
export function recordLoginAndNotifyIfNewIp(user: UserRow, ip: string | undefined, userAgent: string | undefined): void {
  if (!ip) return;
  const isFirstLoginEver = !hasAnyKnownIp(user.id);
  const isNewIp = !isKnownIp(user.id, ip);
  recordLoginIp(user.id, ip, userAgent);

  if (!isFirstLoginEver && isNewIp) {
    enqueueWrite("new_login_ip_alert", { userId: user.id, ip, userAgent });
  }
}

registerWriteQueueHandler("new_login_ip_alert", async (payload) => {
  const { userId, ip, userAgent } = payload as { userId: number; ip: string; userAgent: string | null };
  const user = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || !user.email || !user.notify_email) return;

  const when = new Date().toLocaleString("tr-TR");
  await sendEmail(
    user.email,
    "Hesabınıza yeni bir cihazdan giriş yapıldı",
    `Merhaba ${user.display_name},\n\n${when} tarihinde hesabınıza daha önce görmediğimiz bir IP adresinden (${ip}) giriş yapıldı.` +
      (userAgent ? `\nCihaz/tarayıcı: ${userAgent}` : "") +
      `\n\nBu giriş size ait değilse hemen şifrenizi değiştirin ve diğer oturumları kapatın.`
  );
});
