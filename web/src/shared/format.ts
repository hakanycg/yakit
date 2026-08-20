export const PUMP_STATUS_LABEL: Record<string, string> = {
  idle: "Musait",
  reserved: "Rezerve",
  dispensing: "Dolum Yapiliyor",
  fault: "Ariza",
  offline: "Devre Disi",
};

export const TRANSACTION_STATUS_LABEL: Record<string, string> = {
  created: "Olusturuldu",
  paid: "Odendi",
  authorized: "Yetkilendirildi",
  dispensing: "Dolum Yapiliyor",
  completed: "Tamamlandi",
  cancelled: "Iptal Edildi",
  failed: "Basarisiz",
};

export const ALARM_SEVERITY_LABEL: Record<string, string> = { info: "Bilgi", warning: "Uyari", critical: "Kritik" };
export const ALARM_STATUS_LABEL: Record<string, string> = { active: "Aktif", acknowledged: "Onaylandi", resolved: "Cozuldu" };
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
