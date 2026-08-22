import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import type { FuelStockMovement, FuelTank, SupplierSummaryRow } from "../../shared/types";

const STATUS_LABEL: Record<string, string> = { ok: "Normal", low: "Düşük", critical: "Kritik" };
const STATUS_BADGE: Record<string, string> = { ok: "resolved", low: "warning", critical: "critical" };
const MOVEMENT_TYPE_LABEL: Record<string, string> = { delivery: "Teslimat", sale: "Satış", adjustment: "Düzeltme" };

export default function FuelStock() {
  const stationId = useEffectiveStationId();
  const [tanks, setTanks] = useState<FuelTank[]>([]);
  const [movements, setMovements] = useState<FuelStockMovement[]>([]);
  const [movementFilter, setMovementFilter] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierSummaryRow[]>([]);

  function loadTanks() {
    if (stationId === null) return;
    api.get<{ tanks: FuelTank[] }>("/api/fuel-stock").then((res) => setTanks(res.tanks));
  }
  function loadMovements() {
    if (stationId === null) return;
    const query = movementFilter ? `?fuelType=${movementFilter}` : "";
    api.get<{ movements: FuelStockMovement[] }>(`/api/fuel-stock/movements${query}`).then((res) => setMovements(res.movements));
  }
  function loadSuppliers() {
    if (stationId === null) return;
    api.get<{ suppliers: SupplierSummaryRow[] }>("/api/fuel-stock/suppliers/summary").then((res) => setSuppliers(res.suppliers));
  }

  useEffect(loadTanks, [stationId]);
  useEffect(loadMovements, [stationId, movementFilter]);
  useEffect(loadSuppliers, [stationId]);
  useTopicSubscription(stationId !== null ? `fuel-stock:${stationId}` : null, () => {
    loadTanks();
    loadMovements();
    loadSuppliers();
  });

  const csvHref = appendStationParam(`/api/fuel-stock/movements/export.csv${movementFilter ? `?fuelType=${movementFilter}` : ""}`);

  return (
    <div>
      <h2>Yakıt Stoku</h2>

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
        {tanks.length === 0 && <p className="hint-text">Yükleniyor...</p>}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Stok Hareketleri</h3>
          <div className="spacer" />
          <select value={movementFilter} onChange={(e) => setMovementFilter(e.target.value)} style={{ width: 180 }}>
            <option value="">Tüm yakıt tipleri</option>
            <option value="benzin">Benzin</option>
            <option value="motorin">Motorin</option>
            <option value="lpg">LPG</option>
          </select>
          <a href={csvHref}>
            <button>CSV İndir</button>
          </a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Yakıt</th>
              <th>Tip</th>
              <th className="numeric">Miktar</th>
              <th className="numeric">Bakiye</th>
              <th>İrsaliye/Fiş No</th>
              <th>Detay</th>
              <th>Kullanıcı</th>
              <th>E-İrsaliye</th>
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
                <td>
                  {m.type === "delivery" ? (
                    <DeliveryRefCell movement={m} onChanged={loadMovements} />
                  ) : (
                    m.deliveryRef ?? "-"
                  )}
                </td>
                <td className="hint-text">
                  {[m.supplier, m.unitCost ? `Maliyet: ${formatCurrency(m.unitCost)}/L` : null, m.note, m.transactionId ? `İşlem #${m.transactionId}` : null]
                    .filter(Boolean)
                    .join(" · ") || "-"}
                </td>
                <td>{m.username ?? "-"}</td>
                <td>{m.type === "delivery" && <WaybillCell movementId={m.id} />}</td>
              </tr>
            ))}
            {movements.length === 0 && <tr><td colSpan={9} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Tedarikçi Özeti</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Tüm zamanlar. Ort. Maliyet, yalnızca birim maliyeti girilmiş teslimatlar üzerinden hesaplanır.
        </p>
        <table>
          <thead>
            <tr>
              <th>Tedarikçi</th>
              <th>Yakıt</th>
              <th className="numeric">Teslimat</th>
              <th className="numeric">Toplam Litre</th>
              <th className="numeric">Ort. Maliyet</th>
              <th>Son Teslimat</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={`${s.supplier}-${s.fuelType}`}>
                <td>{s.supplier}</td>
                <td><span className={`fuel-dot ${s.fuelType}`} />{FUEL_LABEL[s.fuelType] ?? s.fuelType}</td>
                <td className="numeric">{s.deliveryCount}</td>
                <td className="numeric">{formatLiters(s.totalLiters)}</td>
                <td className="numeric">{s.avgUnitCost !== null ? `${formatCurrency(s.avgUnitCost)}/L` : "-"}</td>
                <td>{formatDateTime(s.lastDeliveryAt)}</td>
              </tr>
            ))}
            {suppliers.length === 0 && <tr><td colSpan={6} className="hint-text">Kayıt yok.</td></tr>}
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
            <span className="k">Düşük Stok Eşiği</span>
            <span className="v">{formatLiters(tank.lowStockThresholdLiters)}</span>
          </div>
          <div className="tank-stat-row">
            <span className="k">Ort. Maliyet</span>
            <span className="v">{tank.averageCostPerLiter > 0 ? `${formatCurrency(tank.averageCostPerLiter)}/L` : "-"}</span>
          </div>
        </div>
      </div>

      <p className="hint-text" style={{ marginTop: "0.75rem", marginBottom: 0 }}>Son güncelleme: {formatDateTime(tank.updatedAt)}</p>

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
      <div className="card" style={{ width: `min(${width}px, 92vw)`, maxHeight: "90vh", overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function AddStockDialog({ tank, onClose, onAdded }: { tank: FuelTank; onClose: () => void; onAdded: () => void }) {
  const [liters, setLiters] = useState("");
  const [supplier, setSupplier] = useState("");
  const [deliveryRef, setDeliveryRef] = useState("");
  const [unitCost, setUnitCost] = useState("");
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
        deliveryRef: deliveryRef.trim() || undefined,
        unitCost: unitCost.trim() ? Number(unitCost) : undefined,
        note: note.trim() || undefined,
        force: force || undefined,
      });
      if (res.overflow > 0) {
        setError(`Uyarı: tank kapasitesi nedeniyle ${formatLiters(res.overflow)} eklenemedi.`);
        setTimeout(onAdded, 1400);
        return;
      }
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details && typeof err.details === "object" && "duplicate" in err.details) {
        const d = err.details as unknown as { existingCreatedAt: string };
        setDuplicateWarning(
          `Bu irsaliye/fiş no ile ${FUEL_LABEL[tank.fuelType]} için daha önce ${formatDateTime(d.existingCreatedAt)} tarihinde bir teslimat kaydedilmiş. Yine de eklemek istiyor musunuz?`
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

      <label>Tedarikçi</label>
      <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="örn: Petrol Ofisi Tankeri" required />

      <label>İrsaliye / Fiş No <span className="hint-text">(opsiyonel; boş bırakıp Stok Hareketleri tablosundan sonradan da girebilirsiniz)</span></label>
      <input
        value={deliveryRef}
        onChange={(e) => {
          setDeliveryRef(e.target.value);
          setDuplicateWarning(null);
        }}
      />

      <label>Birim Maliyet (TL/L) <span className="hint-text">(opsiyonel; kar raporu için kullanılır)</span></label>
      <input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />

      <label>Not (opsiyonel)</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} />

      {error && <p className="error-text">{error}</p>}
      {duplicateWarning && (
        <p className="hint-text" style={{ color: "var(--warning)" }}>{duplicateWarning}</p>
      )}

      <div className="toolbar" style={{ marginTop: "1.25rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Vazgeç</button>
        <div className="spacer" />
        {duplicateWarning ? (
          <button className="danger" disabled={submitting} onClick={() => submit(true)}>
            {submitting ? "Ekleniyor..." : "Yine de Ekle"}
          </button>
        ) : (
          <button
            className="primary"
            disabled={submitting || !liters || Number(liters) <= 0 || !supplier.trim()}
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
        note: adjustNote.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Düzeltme yapılamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal width={460}>
      <h3 style={{ marginTop: 0 }}>{FUEL_LABEL[tank.fuelType]} — Tank Ayarları</h3>

      <label>Tank Kapasitesi (L)</label>
      <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />

      <label>Düşük Stok Eşiği (L)</label>
      <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <div className="spacer" />
        <button disabled={submitting} onClick={saveSettings}>Kaydet</button>
      </div>

      <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
        <h4 style={{ margin: "0 0 0.25rem" }}>Manuel Stok Düzeltme</h4>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Fiziksel ölçüm, sayaç farkı gibi durumlarda tank seviyesini doğrudan düzeltir. Bu işlem "düzeltme" olarak
          hareket geçmişine kaydedilir.
        </p>
        <label>Gerçek Stok Miktarı (L)</label>
        <input type="number" min={0} value={adjustLiters} onChange={(e) => setAdjustLiters(e.target.value)} />
        <label>Açıklama</label>
        <input
          value={adjustNote}
          onChange={(e) => setAdjustNote(e.target.value)}
          placeholder="örn: Fiziksel ölçüm sonrası düzeltme, sayaç X litre farklı çıktı"
          required
        />
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button className="danger" disabled={submitting || !adjustNote.trim()} onClick={submitAdjust}>Düzelt</button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Kapat</button>
      </div>
    </Modal>
  );
}

function DeliveryRefCell({ movement, onChanged }: { movement: FuelStockMovement; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(movement.deliveryRef ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  async function save(force = false) {
    setSaving(true);
    setError(null);
    if (!force) setDuplicateWarning(null);
    try {
      await api.patch(`/api/fuel-stock/movements/${movement.id}/delivery-ref`, {
        deliveryRef: value.trim() || null,
        force: force || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details && typeof err.details === "object" && "duplicate" in err.details) {
        const d = err.details as unknown as { existingCreatedAt: string };
        setDuplicateWarning(`Bu numara ile daha önce ${formatDateTime(d.existingCreatedAt)} tarihinde bir teslimat kaydedilmiş. Yine de kaydedilsin mi?`);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="toolbar" style={{ gap: "0.4rem", flexWrap: "nowrap" }}>
        <span>{movement.deliveryRef ?? "-"}</span>
        <button
          style={{ padding: "0.1rem 0.5rem", fontSize: "0.75rem" }}
          onClick={() => {
            setValue(movement.deliveryRef ?? "");
            setError(null);
            setDuplicateWarning(null);
            setEditing(true);
          }}
        >
          Düzenle
        </button>
      </div>
    );
  }

  return (
    <div style={{ minWidth: 200 }}>
      <div className="toolbar" style={{ gap: "0.35rem", flexWrap: "nowrap" }}>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDuplicateWarning(null);
          }}
          placeholder="opsiyonel"
          style={{ width: 150 }}
          autoFocus
        />
        {duplicateWarning ? (
          <button className="danger" disabled={saving} style={{ padding: "0.1rem 0.5rem", fontSize: "0.75rem" }} onClick={() => save(true)}>
            {saving ? "..." : "Yine de Kaydet"}
          </button>
        ) : (
          <button className="primary" disabled={saving} style={{ padding: "0.1rem 0.5rem", fontSize: "0.75rem" }} onClick={() => save(false)}>
            {saving ? "..." : "Kaydet"}
          </button>
        )}
        <button disabled={saving} style={{ padding: "0.1rem 0.5rem", fontSize: "0.75rem" }} onClick={() => setEditing(false)}>
          Vazgeç
        </button>
      </div>
      {error && <div className="error-text" style={{ fontSize: "0.75rem" }}>{error}</div>}
      {duplicateWarning && <div className="hint-text" style={{ color: "var(--warning)", fontSize: "0.75rem" }}>{duplicateWarning}</div>}
    </div>
  );
}

interface WaybillInfo {
  status: "pending" | "sent" | "failed";
  providerWaybillId: string | null;
  errorMessage: string | null;
}

function WaybillCell({ movementId }: { movementId: number }) {
  const [waybill, setWaybill] = useState<WaybillInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ waybill: WaybillInfo | null }>(`/api/fuel-stock/movements/${movementId}/waybill`).then((res) => setWaybill(res.waybill));
  }
  useEffect(load, [movementId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ waybill: WaybillInfo }>(`/api/fuel-stock/movements/${movementId}/waybill`);
      setWaybill(res.waybill);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İrsaliye oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  if (waybill === undefined) return <span className="hint-text">...</span>;

  if (waybill?.status === "sent") {
    return <span className="badge resolved" title={waybill.providerWaybillId ?? undefined}>Kesildi</span>;
  }

  return (
    <div>
      <button onClick={create} disabled={busy}>{busy ? "..." : "E-İrsaliye Oluştur"}</button>
      {error && <div className="error-text" style={{ fontSize: "0.75rem", maxWidth: 220 }}>{error}</div>}
      {!error && waybill?.status === "failed" && (
        <div className="error-text" style={{ fontSize: "0.75rem", maxWidth: 220 }}>{waybill.errorMessage}</div>
      )}
    </div>
  );
}
