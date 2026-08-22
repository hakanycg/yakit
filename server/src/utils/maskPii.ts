/**
 * Uygulamanin is kayitlari (audit_log/alarms tablolari - operasyonel amacla PLAKA/
 * e-posta/telefon gibi bilgilerin TAM gorunmesi personelin gorevini yapabilmesi icin
 * gereklidir) ile tanisal LOG cikisini (pino - genelde stdout'a yazilir, disk/3.
 * parti log toplama servislerine gidebilir, uzun sureli/az kontrollu saklanabilir)
 * KASITLI olarak farkli ele aliriz: LOG satirlarina giren iletisim bilgileri (e-posta/
 * telefon) burada maskelenir - KVKK'nin veri minimizasyonu ilkesi (m.4) geregi, o
 * log satirinin islevi (ör. "SMTP yapilandirilmamis" uyarisi) icin alicinin TAM
 * kimligi gerekli degildir.
 */
export function maskContact(to: string): string {
  const at = to.indexOf("@");
  if (at > 0) {
    const local = to.slice(0, at);
    const domain = to.slice(at + 1);
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
  }
  const digits = to.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(to.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
