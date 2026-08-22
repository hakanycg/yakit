import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, formatCurrency, formatDateTime } from "../../shared/format";

interface DiscountCode {
  id: number;
  code: string;
  type: "percent" | "fixed";
  value: number;
  fuelType: string | null;
  maxUses: number | null;
  usedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  stats: { completedUses: number; totalDiscountGiven: number; revenueGenerated: number };
}

export default function DiscountCodes() {
  const stationId = useEffectiveStationId();
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (stationId === null) return;
    api.get<{ codes: DiscountCode[] }>("/api/discount-codes").then((res) => setCodes(res.codes));
  }
  useEffect(load, [stationId]);

  async function toggleActive(c: DiscountCode) {
    setError(null);
    try {
      await api.patch(`/api/discount-codes/${c.id}/active`, { active: !c.active });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Güncellenemedi.");
    }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Kampanya Kodları</h2>
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni Kod</button>
      </div>
      <p className="hint-text">
        Müşteriler kiosk'ta miktar seçiminde bu kodları girip indirim uygulayabilir. Kod, sadakat puanı indirimiyle
        birlikte de kullanılabilir.
      </p>
      {error && <p className="error-text">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Kod</th><th>Tip</th><th className="numeric">Değer</th><th>Yakıt</th>
            <th className="numeric">Kullanım</th><th className="numeric">Tamamlanan Satış</th>
            <th className="numeric">Verilen İndirim</th><th className="numeric">Getirdiği Ciro</th>
            <th>Başlangıç</th><th>Bitiş</th><th>Durum</th><th></th>
          </tr>
        </thead>
        <tbody>
          {codes.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.code}</strong></td>
              <td>{c.type === "percent" ? "Yüzde" : "Sabit Tutar"}</td>
              <td className="numeric">{c.type === "percent" ? `%${c.value}` : formatCurrency(c.value)}</td>
              <td>{c.fuelType ? (FUEL_LABEL[c.fuelType] ?? c.fuelType) : "Tümü"}</td>
              <td className="numeric">{c.usedCount}{c.maxUses !== null ? ` / ${c.maxUses}` : ""}</td>
              <td className="numeric">{c.stats.completedUses}</td>
              <td className="numeric">{c.stats.totalDiscountGiven > 0 ? formatCurrency(c.stats.totalDiscountGiven) : "-"}</td>
              <td className="numeric">{c.stats.revenueGenerated > 0 ? formatCurrency(c.stats.revenueGenerated) : "-"}</td>
              <td>{c.startsAt ? formatDateTime(c.startsAt) : "-"}</td>
              <td>{c.expiresAt ? formatDateTime(c.expiresAt) : "-"}</td>
              <td><span className={`badge ${c.active ? "resolved" : "critical"}`}>{c.active ? "Aktif" : "Pasif"}</span></td>
              <td><button onClick={() => toggleActive(c)}>{c.active ? "Pasife Al" : "Aktif Et"}</button></td>
            </tr>
          ))}
          {codes.length === 0 && <tr><td colSpan={12} className="hint-text">Henüz kampanya kodu yok.</td></tr>}
        </tbody>
      </table>

      {showCreate && (
        <CreateCodeDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width: "min(520px, 92vw)", maxHeight: "90vh", overflowY: "auto" }}>{children}</div>
    </div>
  );
}

function CreateCodeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [type, setType] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [fuelType, setFuelType] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/discount-codes", {
        code: code.trim(),
        type,
        value: Number(value),
        fuelType: fuelType || undefined,
        maxUses: maxUses ? Number(maxUses) : undefined,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kod oluşturulamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal>
      <h3 style={{ marginTop: 0 }}>Yeni Kampanya Kodu</h3>

      <label>Kod</label>
      <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="örn: YAZ2026" autoFocus />

      <label>İndirim Tipi</label>
      <select value={type} onChange={(e) => setType(e.target.value as "percent" | "fixed")}>
        <option value="percent">Yüzde (%)</option>
        <option value="fixed">Sabit Tutar (TL)</option>
      </select>

      <label>Değer</label>
      <input type="number" min={0} step={0.01} value={value} onChange={(e) => setValue(e.target.value)} />

      <label>Yakıt Tipi (opsiyonel, boş = tümü)</label>
      <select value={fuelType} onChange={(e) => setFuelType(e.target.value)}>
        <option value="">Tüm yakıt tipleri</option>
        <option value="benzin">Benzin</option>
        <option value="motorin">Motorin</option>
        <option value="lpg">LPG</option>
      </select>

      <label>Maksimum kullanım (opsiyonel)</label>
      <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />

      <div className="field-grid">
        <div>
          <label>Başlangıç tarihi (opsiyonel)</label>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div>
          <label>Son kullanma tarihi (opsiyonel)</label>
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1.25rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Vazgeç</button>
        <div className="spacer" />
        <button className="primary" disabled={submitting || !code.trim() || !value} onClick={submit}>
          {submitting ? "Oluşturuluyor..." : "Oluştur"}
        </button>
      </div>
    </Modal>
  );
}
