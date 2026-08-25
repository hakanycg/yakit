import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { useEscapeKey } from "../../shared/useEscapeKey";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { ALARM_SEVERITY_LABEL, ALARM_STATUS_LABEL, formatDateTime } from "../../shared/format";
import type { Alarm, AlarmEscalationSettings } from "../../shared/types";
import { useAuth } from "../../shared/AuthContext";

export default function Alarms() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [statusFilter, setStatusFilter] = useState<"active" | "acknowledged" | "resolved" | "">("active");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [escalation, setEscalation] = useState<AlarmEscalationSettings | null>(null);
  const [showEscalation, setShowEscalation] = useState(false);

  function load() {
    if (stationId === null) return;
    const query = statusFilter ? `?status=${statusFilter}` : "";
    api.get<{ alarms: Alarm[] }>(`/api/alarms${query}`).then((res) => setAlarms(res.alarms));
  }

  useEffect(load, [statusFilter, stationId]);

  useEffect(() => {
    if (stationId === null) return;
    api
      .get<{ settings: AlarmEscalationSettings }>("/api/alarms/escalation")
      .then((res) => setEscalation(res.settings))
      .catch(() => setEscalation(null));
  }, [stationId]);
  useTopicSubscription(stationId !== null ? `alarms:${stationId}` : null, () => load());

  const canManage = user?.role === "admin" || user?.role === "operator" || user?.role === "super_admin";

  async function act(id: number, action: "acknowledge" | "resolve") {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/alarms/${id}/${action}`, {});
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İşlem başarısız.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2>Alarm Merkezi</h2>
      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} style={{ width: 220 }}>
          <option value="active">Aktif</option>
          <option value="acknowledged">Onaylandı</option>
          <option value="resolved">Çözüldü</option>
          <option value="">Tümü</option>
        </select>
        <div className="spacer" />
        {canManage && escalation && (
          <button type="button" onClick={() => setShowEscalation(true)}>
            Yükseltme Ayarları
          </button>
        )}
      </div>
      <p className="hint-text">
        Cevaplanmayan kritik alarmlar {escalation ? `${escalation.reminderMinutes} dakika` : "bir süre"} sonra
        hatırlatılır, {escalation ? `${escalation.escalateMinutes} dakika` : "daha sonra"} sonra dağıtım şirketi ve
        platform yöneticisine yükseltilir. <strong>Onaylanan alarm için hatırlatma durur</strong> — çözülmesi beklenmez.
        Yangın/gaz kaynaklı acil durdurma için süre çok daha kısadır ve değiştirilemez.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr><th>Önem</th><th>Tip</th><th>Mesaj</th><th>Durum</th><th>Zaman</th>{canManage && <th>İşlem</th>}</tr>
          </thead>
          <tbody>
            {alarms.map((a) => (
              <tr key={a.id}>
                <td><span className={`badge ${a.severity}`}>{ALARM_SEVERITY_LABEL[a.severity]}</span></td>
                <td>{a.type}</td>
                <td>
                  {a.message}
                  {a.type === "pump_fault" && a.status !== "resolved" && (
                    <div className="hint-text">"Çöz" ile kapatmak ilgili pompayı da otomatik olarak kullanıma açar.</div>
                  )}
                </td>
                <td>
                  <span className={`badge ${a.status}`}>{ALARM_STATUS_LABEL[a.status]}</span>
                  {/* Operatorun "haber verildi mi?" sorusunun cevabi listede gorunmeli. */}
                  {a.status === "active" && a.escalationLevel > 0 && (
                    <div className="hint-text">
                      {a.escalationLevel >= 2 ? "üst kademeye yükseltildi" : "hatırlatma gönderildi"}
                      {a.lastNotifiedAt && ` · ${formatDateTime(a.lastNotifiedAt)}`}
                    </div>
                  )}
                </td>
                <td>{formatDateTime(a.createdAt)}</td>
                {canManage && (
                  <td>
                    <div className="toolbar" style={{ margin: 0 }}>
                      {a.status === "active" && (
                        <button disabled={busyId === a.id} onClick={() => act(a.id, "acknowledge")}>Onayla</button>
                      )}
                      {a.status !== "resolved" && (
                        <button disabled={busyId === a.id} className="success" onClick={() => act(a.id, "resolve")}>Çöz</button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {alarms.length === 0 && <tr><td colSpan={canManage ? 6 : 5} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
      {showEscalation && escalation && (
        <EscalationDialog
          settings={escalation}
          onClose={() => setShowEscalation(false)}
          onSaved={(next) => {
            setEscalation(next);
            setShowEscalation(false);
          }}
        />
      )}
    </div>
  );
}

function EscalationDialog({
  settings,
  onClose,
  onSaved,
}: {
  settings: AlarmEscalationSettings;
  onClose: () => void;
  onSaved: (next: AlarmEscalationSettings) => void;
}) {
  const [reminder, setReminder] = useState(String(settings.reminderMinutes));
  const [escalate, setEscalate] = useState(String(settings.escalateMinutes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEscapeKey(onClose);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<{ settings: AlarmEscalationSettings }>("/api/alarms/escalation", {
        reminderMinutes: Number(reminder),
        escalateMinutes: Number(escalate),
      });
      onSaved(res.settings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="escalation-title"
    >
      <div className="card" style={{ width: "min(480px, 92vw)" }}>
        <h3 id="escalation-title" style={{ marginTop: 0 }}>
          Alarm Yükseltme Ayarları
        </h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Süreler alarmın <strong>oluşma anından</strong> itibaren sayılır. Süreyi çok kısa tutmak, insanları bildirim
          kanalını tamamen susturmaya iter — o zaman özellik, çözmeye çalıştığı sorunun kendisine dönüşür.
        </p>

        <label htmlFor="esc-reminder">Hatırlatma (dakika)</label>
        <input id="esc-reminder" type="number" min={1} max={1440} value={reminder} onChange={(e) => setReminder(e.target.value)} />
        <p className="hint-text">Alarm bu süre içinde onaylanmazsa aynı kişilere tekrar bildirilir.</p>

        <label htmlFor="esc-escalate">Üst kademeye yükseltme (dakika)</label>
        <input id="esc-escalate" type="number" min={1} max={1440} value={escalate} onChange={(e) => setEscalate(e.target.value)} />
        <p className="hint-text">
          Hâlâ onaylanmamışsa dağıtım şirketi yöneticisi ve platform yöneticisi de bilgilendirilir. Bundan sonra tekrar
          gönderilmez.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="toolbar" style={{ marginTop: "1.25rem", marginBottom: 0 }}>
          <button type="button" onClick={onClose} disabled={saving}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
