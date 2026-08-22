export const PUMP_STATUS_LABEL: Record<string, string> = {
  idle: "Müsait",
  reserved: "Rezerve",
  dispensing: "Dolum Yapılıyor",
  fault: "Arıza",
  offline: "Devre Dışı",
};

export const TRANSACTION_STATUS_LABEL: Record<string, string> = {
  created: "Oluşturuldu",
  paid: "Ödendi",
  authorized: "Yetkilendirildi",
  dispensing: "Dolum Yapılıyor",
  completed: "Tamamlandı",
  cancelled: "İptal Edildi",
  failed: "Başarısız",
};

export const ALARM_SEVERITY_LABEL: Record<string, string> = { info: "Bilgi", warning: "Uyarı", critical: "Kritik" };
export const ALARM_STATUS_LABEL: Record<string, string> = { active: "Aktif", acknowledged: "Onaylandı", resolved: "Çözüldü" };
export const FUEL_LABEL: Record<string, string> = { benzin: "Benzin", motorin: "Motorin", lpg: "LPG" };

export function formatCurrency(value: number, locale = "tr-TR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "TRY" }).format(value);
}

export function formatDateTime(value: string | null, locale = "tr-TR"): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

export function formatLiters(value: number): string {
  return `${value.toFixed(2)} L`;
}

/** Sidebar avatar rozetleri icin: "Merkez Yakit Istasyonu" -> "MY", "Admin" -> "AD". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}
