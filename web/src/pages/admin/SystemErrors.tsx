import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { formatDateTime } from "../../shared/format";

/**
 * Sunucu hatalari - platform yoneticisine ozel teshis ekrani.
 *
 * Bu ekranin varlik sebebi su bosluktu: sistemde 20'den fazla alarm tipi vardi ama
 * "sunucu hata veriyor" icin hicbiri yoktu. Bir filo hesabinin bakiyesi 100 TL
 * azaldiginda SMS gidiyor, API tum kiosk'lara 500 dondurdugunde hicbir sey gitmiyordu.
 *
 * Alarm artik uretiliyor (bkz. systemErrorService.ts); bu ekran alarmin ardindan
 * "ne oldu" sorusunun cevabini loglara girmeden verir.
 */

interface SystemErrorHealth {
  recentCount: number;
  windowMinutes: number;
  threshold: number;
  lastErrorAt: string | null;
}

interface SystemError {
  id: number;
  kind: "request" | "uncaught_exception" | "unhandled_rejection";
  path: string | null;
  message: string;
  createdAt: string;
}

const KIND_LABEL: Record<SystemError["kind"], string> = {
  request: "İstek",
  uncaught_exception: "Yakalanmamış istisna",
  unhandled_rejection: "Yakalanmamış promise reddi",
};

/** İstek dışı hatalar daha ciddidir: bir kod yolu hiç korumasız kalmış demektir. */
const KIND_BADGE: Record<SystemError["kind"], string> = {
  request: "warning",
  uncaught_exception: "critical",
  unhandled_rejection: "critical",
};

export default function SystemErrors() {
  const [health, setHealth] = useState<SystemErrorHealth | null>(null);
  const [errors, setErrors] = useState<SystemError[]>([]);

  useEffect(() => {
    api
      .get<{ health: SystemErrorHealth; errors: SystemError[] }>("/api/system/errors")
      .then((r) => {
        setHealth(r.health);
        setErrors(r.errors);
      })
      .catch(() => setErrors([]));
  }, []);

  const overThreshold = health !== null && health.recentCount >= health.threshold;

  return (
    <div>
      <h2>Sunucu Hataları</h2>
      <p className="hint-text">
        İşlenmeyen sunucu hataları. Eşik aşıldığında sistem geneli kritik alarm üretilir ve mevcut e-posta/SMS
        zincirinden bildirilir; hata akışı tamamen durduğunda alarm kendiliğinden çözülür.
      </p>

      {health && (
        <div className="grid stats-grid">
          <div className="card stat">
            <span className="label">Son {health.windowMinutes} dakika</span>
            <span className="value" style={overThreshold ? { color: "#f87171" } : undefined}>
              {health.recentCount}
            </span>
            <span className="stat-caption">Alarm eşiği: {health.threshold}</span>
          </div>
          <div className="card stat">
            <span className="label">Son hata</span>
            <span className="value" style={{ fontSize: "1.1rem" }}>
              {health.lastErrorAt ? formatDateTime(health.lastErrorAt) : "—"}
            </span>
            <span className="stat-caption">{health.lastErrorAt ? "" : "Kayıtlı hata yok"}</span>
          </div>
        </div>
      )}

      <h3>Son Hatalar</h3>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Zaman</th>
              <th>Tür</th>
              <th>Uç</th>
              <th>Mesaj</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={e.id}>
                <td className="hint-text">{formatDateTime(e.createdAt)}</td>
                <td>
                  <span className={`badge ${KIND_BADGE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
                </td>
                <td className="hint-text">
                  <code>{e.path ?? "—"}</code>
                </td>
                <td>{e.message}</td>
              </tr>
            ))}
            {errors.length === 0 && (
              <tr>
                <td colSpan={4} className="hint-text">
                  Kayıtlı sunucu hatası yok. Beklenen durum budur.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="hint-text">
        Bu tablo teşhis içindir, arşiv değil: 30 günden eski kayıtlar otomatik budanır.
      </p>
    </div>
  );
}
