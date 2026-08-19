import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { FUEL_LABEL, formatDateTime, formatLiters } from "../../shared/format";
import type { FuelStockMovement, FuelTank } from "../../shared/types";

const STATUS_LABEL: Record<string, string> = { ok: "Normal", low: "Dusuk", critical: "Kritik" };
const STATUS_BADGE: Record<string, string> = { ok: "resolved", low: "warning", critical: "critical" };
const MOVEMENT_TYPE_LABEL: Record<string, string> = { delivery: "Teslimat", sale: "Satis", adjustment: "Duzeltme" };

export default function FuelStock() {
  const stationId = useEffectiveStationId();
  const [tanks, setTanks] = useState<FuelTank[]>([]);
  const [movements, setMovements] = useState<FuelStockMovement[]>([]);
  const [movementFilter, setMovementFilter] = useState("");

  function loadTanks() {
    if (stationId === null) return;
    api.get<{ tanks: FuelTank[] }>("/api/fuel-stock").then((res) => setTanks(res.tanks));
  }
  function loadMovements() {
    if (stationId === null) return;
    const query = movementFilter ? `?fuelType=${movementFilter}` : "";
    api.get<{ movements: FuelStockMovement[] }>(`/api/fuel-stock/movements${query}`).then((res) => setMovements(res.movements));
  }

  useEffect(loadTanks, [stationId]);
  useEffect(loadMovements, [stationId, movementFilter]);
  useTopicSubscription(stationId !== null ? `fuel-stock:${stationId}` : null, () => {
    loadTanks();
    loadMovements();
  });

  const csvHref = appendStationParam(`/api/fuel-stock/movements/export.csv${movementFilter ? `?fuelType=${movementFilter}` : ""}`);

  return (
    <div>
      <h2>Yakit Stoku</h2>

      <div className="tank-grid">
        {tanks.map((t) => (
          <TankCard
            key={t.fuelType}
            tank={t}
            onChanged={() => {
              loadTanks();
              loadMovements();
            }}
          />
        ))}
        {tanks.length === 0 && <p className="hint-text">Yukleniyor...</p>}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Stok Hareketleri</h3>
          <div className="spacer" />
          <select value={movementFilter} onChange={(e) => setMovementFilter(e.target.value)} style={{ width: 180 }}>
            <option value="">Tum yakit tipleri</option>
            <option value="benzin">Benzin</option>
            <option value="motorin">Motorin</option>
            <option value="lpg">LPG</option>
          </select>
          <a href={csvHref}>
            <button>CSV Indir</button>
          </a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Yakit</th>
              <th>Tip</th>
              <th className="numeric">Miktar</th>
              <th className="numeric">Bakiye</th>
              <th>Irsaliye/Fis No</th>
              <th>Detay</th>
              <th>Kullanici</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{formatDateTime(m.createdAt)}</td>
                <td><span className={`fuel-dot ${m.fuelType}`} />{FUEL_LABEL[m.fuelType] ?? m.fuelType}</td>
                <td><span className={`movement-type-pill ${m.type}`}>{MOVEMENT_TYPE_LABEL[m.type] ?? m.type}</span></td>
                <td className="numeric" style={{ color: m.liters < 0 ? "var(--danger)" : "var(--accent-2)" }}>
                  {m.liters > 0 ? "+" : ""}{formatLiters(m.liters)}
                </td>
                <td className="numeric">{formatLiters(m.balanceAfter)}</td>
                <td>{m.deliveryRef ?? "-"}</td>
                <td className="hint-text">
                  {[m.supplier, m.note, m.transactionId ? `Islem #${m.transactionId}` : null].filter(Boolean).join(" · ") || "-"}
                </td>
                <td>{m.username ?? "-"}</td>
              </tr>
            ))}
            {movements.length === 0 && <tr><td colSpan={8} className="hint-text">Kayit yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TankCard({ tank, onChanged }: { tank: FuelTank; onChanged: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const criticalZoneHeight = tank.capacityLiters > 0 ? (tank.lowStockThresholdLiters / tank.capacityLiters) * 100 : 0;

  return (
    <div className="card tank-card">
      <div className="tank-card-head">
        <span className="tank-card-title"><span className={`fuel-dot ${tank.fuelType}`} />{FUEL_LABEL[tank.fuelType] ?? tank.fuelType}</span>
        <span className={`badge ${STATUS_BADGE[tank.status]}`}>{STATUS_LABEL[tank.status]}</span>
      </div>

      <div className="tank-body">
        <div className="tank-gauge">
          <div className="tank-gauge-critical-zone" style={{ height: `${criticalZoneHeight}%` }} />
          <div className="tank-gauge-mark" style={{ bottom: "25%" }} />
          <div className="tank-gauge-mark" style={{ bottom: "50%" }} />
          <div className="tank-gauge-mark" style={{ bottom: "75%" }} />
          <div className={`tank-gauge-fill ${tank.fuelType}`} style={{ height: `${Math.min(100, tank.percentFull)}%` }} />
        </div>

        <div className="tank-stats">
          <div className="tank-stat-row headline">
            <span className="k">Mevcut</span>
            <span className="v">{formatLiters(tank.currentLiters)}</span>
          </div>
          <div className="tank-stat-row">
            <span className="k">Kapasite</span>
            <span className="v">{formatLiters(tank.capacityLiters)}</span>
          </div>
          <div className="tank-stat-row">
            <span className="k">Doluluk</span>
            <span className="v">%{tank.percentFull.toFixed(1)}</span>
          </div>
          <div className="tank-stat-row">
            <span className="k">Dusuk Stok Esigi</span>
            <span className="v">{formatLiters(tank.lowStockThresholdLiters)}</span>
          </div>
        </div>
      </div>

      <p className="hint-text" style={{ marginTop: "0.75rem", marginBottom: 0 }}>Son guncelleme: {formatDateTime(tank.updatedAt)}</p>

      <div className="tank-actions">
        <button className="primary" onClick={() => setShowAdd(true)}>Stok Ekle</button>
        <button onClick={() => setShowSettings(true)}>Ayarlar</button>
      </div>

      {showAdd && (
        <AddStockDialog
          tank={tank}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            onChanged();
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          tank={tank}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function Modal({ children, width = 420 }: { children: React.ReactNode; width?: number }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width, maxHeight: "90vh", overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function AddStockDialog({ tank, onClose, onAdded }: { tank: FuelTank; onClose: () => void; onAdded: () => void }) {
  const [liters, setLiters] = useState("");
  const [supplier, setSupplier] = useState("");
  const [deliveryRef, setDeliveryRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(force = false) {
    setSubmitting(true);
    setError(null);
    if (!force) setDuplicateWarning(null);
    try {
      const res = await api.post<{ tank: FuelTank; overflow: number }>(`/api/fuel-stock/${tank.fuelType}/add`, {
        liters: Number(liters),
        supplier: supplier.trim(),
        deliveryRef: deliveryRef.trim(),
        note: note.trim() || undefined,
        force: force || undefined,
      });
      if (res.overflow > 0) {
        setError(`Uyari: tank kapasitesi nedeniyle ${formatLiters(res.overflow)} eklenemedi.`);
        setTimeout(onAdded, 1400);
        return;
      }
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details && typeof err.details === "object" && "duplicate" in err.details) {
        const d = err.details as unknown as { existingCreatedAt: string };
        setDuplicateWarning(
          `Bu irsaliye/fis no ile ${FUEL_LABEL[tank.fuelType]} icin daha once ${formatDateTime(d.existingCreatedAt)} tarihinde bir teslimat kaydedilmis. Yine de eklemek istiyor musunuz?`
        );
        return;
      }
      setError(err instanceof ApiError ? err.message : "Stok eklenemedi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal>
      <h3 style={{ marginTop: 0 }}>{FUEL_LABEL[tank.fuelType]} — Stok Ekle</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Mevcut: {formatLiters(tank.currentLiters)} / {formatLiters(tank.capacityLiters)}
      </p>

      <label>Eklenecek Miktar (L)</label>
      <input type="number" min={1} value={liters} onChange={(e) => setLiters(e.target.value)} autoFocus />

      <label>Tedarikci</label>
      <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="orn: Petrol Ofisi Tankeri" required />

      <label>Irsaliye / Fis No</label>
      <input
        value={deliveryRef}
        onChange={(e) => {
          setDeliveryRef(e.target.value);
          setDuplicateWarning(null);
        }}
        required
      />

      <label>Not (opsiyonel)</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} />

      {error && <p className="error-text">{error}</p>}
      {duplicateWarning && (
        <p className="hint-text" style={{ color: "var(--warning)" }}>{duplicateWarning}</p>
      )}

      <div className="toolbar" style={{ marginTop: "1.25rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Vazgec</button>
        <div className="spacer" />
        {duplicateWarning ? (
          <button className="danger" disabled={submitting} onClick={() => submit(true)}>
            {submitting ? "Ekleniyor..." : "Yine de Ekle"}
          </button>
        ) : (
          <button
            className="primary"
            disabled={submitting || !liters || Number(liters) <= 0 || !supplier.trim() || !deliveryRef.trim()}
            onClick={() => submit(false)}
          >
            {submitting ? "Ekleniyor..." : "Stok Ekle"}
          </button>
        )}
      </div>
    </Modal>
  );
}

function SettingsDialog({ tank, onClose, onSaved }: { tank: FuelTank; onClose: () => void; onSaved: () => void }) {
  const [capacity, setCapacity] = useState(String(tank.capacityLiters));
  const [threshold, setThreshold] = useState(String(tank.lowStockThresholdLiters));
  const [adjustLiters, setAdjustLiters] = useState(String(tank.currentLiters));
  const [adjustNote, setAdjustNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function saveSettings() {
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(`/api/fuel-stock/${tank.fuelType}/settings`, {
        capacityLiters: Number(capacity),
        lowStockThresholdLiters: Number(threshold),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayarlar kaydedilemedi.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAdjust() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/fuel-stock/${tank.fuelType}/adjust`, {
        newLiters: Number(adjustLiters),
        note: adjustNote.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Duzeltme yapilamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal width={460}>
      <h3 style={{ marginTop: 0 }}>{FUEL_LABEL[tank.fuelType]} — Tank Ayarlari</h3>

      <label>Tank Kapasitesi (L)</label>
      <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />

      <label>Dusuk Stok Esigi (L)</label>
      <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <div className="spacer" />
        <button disabled={submitting} onClick={saveSettings}>Kaydet</button>
      </div>

      <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
        <h4 style={{ margin: "0 0 0.25rem" }}>Manuel Stok Duzeltme</h4>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Fiziksel olcum, sayac farki gibi durumlarda tank seviyesini dogrudan duzeltir. Bu islem "duzeltme" olarak
          hareket gecmisine kaydedilir.
        </p>
        <label>Gercek Stok Miktari (L)</label>
        <input type="number" min={0} value={adjustLiters} onChange={(e) => setAdjustLiters(e.target.value)} />
        <label>Aciklama (opsiyonel)</label>
        <input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="orn: Fiziksel olcum sonrasi duzeltme" />
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button className="danger" disabled={submitting} onClick={submitAdjust}>Duzelt</button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Kapat</button>
      </div>
    </Modal>
  );
}
