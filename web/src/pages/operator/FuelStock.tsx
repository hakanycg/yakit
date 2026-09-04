import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import Pagination from "../../shared/Pagination";
import type {
  DeliveryVariance,
  FuelStockMovement,
  FuelTank,
  SupplierDeliveryVarianceRow,
  SupplierSummaryRow,
} from "../../shared/types";

const STATUS_LABEL: Record<string, string> = { ok: "Normal", low: "Düşük", critical: "Kritik" };
const STATUS_BADGE: Record<string, string> = { ok: "resolved", low: "warning", critical: "critical" };
const MOVEMENT_TYPE_LABEL: Record<string, string> = { delivery: "Teslimat", sale: "Satış", adjustment: "Düzeltme" };
const MOVEMENT_PAGE_SIZE = 25;

export default function FuelStock() {
  const stationId = useEffectiveStationId();
  const [tanks, setTanks] = useState<FuelTank[]>([]);
  const [movements, setMovements] = useState<FuelStockMovement[]>([]);
  const [movementFilter, setMovementFilter] = useState("");
  const [movementFrom, setMovementFrom] = useState("");
  const [movementTo, setMovementTo] = useState("");
  const [movementTotal, setMovementTotal] = useState(0);
  const [movementPage, setMovementPage] = useState(1);
  const [suppliers, setSuppliers] = useState<SupplierSummaryRow[]>([]);
  const [deliveryVariance, setDeliveryVariance] = useState<SupplierDeliveryVarianceRow[]>([]);
  const [orderSuggestions, setOrderSuggestions] = useState<OrderSuggestion[]>([]);
  const [orders, setOrders] = useState<FuelOrder[]>([]);
  const [orderSuppliers, setOrderSuppliers] = useState<OrderSupplier[]>([]);

  // Filtre degistiginde sayfa 1'e donulur - AYNI olay isleyicisinde, aksi halde
  // eski sayfa+yeni filtreyle bir kere, sayfa 1+yeni filtreyle bir kere olmak
  // uzere CIFT sorgu atilirdi (bkz. Alarms.tsx/Stations.tsx'teki ayni desen).
  function updateMovementFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setMovementPage(1);
  }

  function movementParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (movementFilter) params.set("fuelType", movementFilter);
    if (movementFrom) params.set("from", movementFrom);
    if (movementTo) params.set("to", movementTo);
    return params;
  }

  function loadTanks() {
    if (stationId === null) return;
    api.get<{ tanks: FuelTank[] }>("/api/fuel-stock").then((res) => setTanks(res.tanks));
  }
  function loadMovements() {
    if (stationId === null) return;
    const params = movementParams();
    params.set("page", String(movementPage));
    params.set("pageSize", String(MOVEMENT_PAGE_SIZE));
    api
      .get<{ movements: FuelStockMovement[]; total: number }>(`/api/fuel-stock/movements?${params.toString()}`)
      .then((res) => {
        setMovements(res.movements);
        setMovementTotal(res.total);
      });
  }
  function loadSuppliers() {
    if (stationId === null) return;
    api.get<{ suppliers: SupplierSummaryRow[] }>("/api/fuel-stock/suppliers/summary").then((res) => setSuppliers(res.suppliers));
    api
      .get<{ suppliers: SupplierDeliveryVarianceRow[] }>("/api/fuel-stock/delivery-variance/suppliers")
      .then((res) => setDeliveryVariance(res.suppliers))
      .catch(() => setDeliveryVariance([]));
  }

  function loadOrders() {
    if (stationId === null) return;
    api.get<{ suggestions: OrderSuggestion[] }>("/api/fuel-stock/orders/suggestions").then((r) => setOrderSuggestions(r.suggestions));
    // Acik siparisler (taslak/gonderildi) dogasi geregi az sayida ve gunceldir - tek
    // sayfada (pageSize buyuk) hepsi gorunur, ayrica sayfalamaya gerek yok. Gecmis
    // (teslim alindi/iptal) icin GERCEK filtre+sayfalama FuelOrdersSection icinde,
    // ayri bir uctan (bkz. HistorySection) yonetilir - o taraf zamanla buyur.
    api.get<{ orders: FuelOrder[] }>("/api/fuel-stock/orders?pageSize=100").then((r) => setOrders(r.orders));
    api.get<{ suppliers: OrderSupplier[] }>("/api/fuel-stock/suppliers").then((r) => setOrderSuppliers(r.suppliers));
  }

  useEffect(loadTanks, [stationId]);
  useEffect(loadMovements, [stationId, movementFilter, movementFrom, movementTo, movementPage]);
  useEffect(loadSuppliers, [stationId]);
  useEffect(loadOrders, [stationId]);
  useTopicSubscription(stationId !== null ? `fuel-stock:${stationId}` : null, () => {
    loadTanks();
    loadMovements();
    loadSuppliers();
    loadOrders();
  });

  const csvHref = appendStationParam(`/api/fuel-stock/movements/export.csv?${movementParams().toString()}`);

  return (
    <div>
      <h2>Yakıt Stoku</h2>

      <div className="tank-grid">
        {tanks.map((t) => (
          <TankCard
            key={t.fuelType}
            tank={t}
            deliveringOrder={orders.find((o) => o.fuelType === t.fuelType && o.status === "delivering")}
            onChanged={() => {
              loadTanks();
              loadMovements();
            }}
          />
        ))}
        {tanks.length === 0 && <p className="hint-text">Yükleniyor...</p>}
      </div>

      <FuelOrdersSection
        suggestions={orderSuggestions}
        orders={orders}
        suppliers={orderSuppliers}
        onChanged={() => {
          loadOrders();
          loadTanks();
          loadMovements();
          loadSuppliers();
        }}
      />

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Stok Hareketleri</h3>
          <div className="spacer" />
          <select
            value={movementFilter}
            onChange={(e) => updateMovementFilter(setMovementFilter, e.target.value)}
            style={{ width: 180 }}
          >
            <option value="">Tüm yakıt tipleri</option>
            <option value="benzin">Benzin</option>
            <option value="motorin">Motorin</option>
            <option value="lpg">LPG</option>
          </select>
          <label htmlFor="fs-mov-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input
            id="fs-mov-from"
            type="date"
            value={movementFrom}
            onChange={(e) => updateMovementFilter(setMovementFrom, e.target.value)}
            style={{ maxWidth: 150 }}
          />
          <label htmlFor="fs-mov-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input
            id="fs-mov-to"
            type="date"
            value={movementTo}
            onChange={(e) => updateMovementFilter(setMovementTo, e.target.value)}
            style={{ maxWidth: 150 }}
          />
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
                  {[
                    m.supplier,
                    // Eksik gelen teslimat listede de gorunmeli: alarm kapatilmis olsa
                    // bile kayit kalicidir ve tedarikciyle gorusmenin dayanagi budur.
                    m.deliveryVarianceLiters !== null && m.deliveryVarianceLiters !== 0
                      ? `İrsaliye: ${formatLiters(m.declaredLiters ?? 0)} · Fark: ${m.deliveryVarianceLiters > 0 ? "+" : ""}${formatLiters(m.deliveryVarianceLiters)} (%${Math.abs(m.deliveryVariancePct ?? 0)})`
                      : null,
                    m.unitCost ? `Maliyet: ${formatCurrency(m.unitCost)}/L` : null,
                    m.note,
                    m.transactionId ? `İşlem #${m.transactionId}` : null,
                  ]
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
        <Pagination
          page={movementPage}
          pageCount={Math.max(Math.ceil(movementTotal / MOVEMENT_PAGE_SIZE), 1)}
          onChange={setMovementPage}
        />
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Teslimat Kabul Farkı — Tedarikçi Karnesi</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          İrsaliyedeki miktar ile tanka <strong>fiilen giren</strong> miktarın farkı. Tek bir teslimattaki küçük fark
          tolerans içindedir ve alarm üretmez; ama aynı tedarikçi <em>her seferinde</em> eksik getiriyorsa bu bir tolerans
          değil bir <strong>desendir</strong> ve yalnızca toplamda görünür. Yalnızca ölçümü girilen teslimatlar sayılır.
        </p>
        <table>
          <thead>
            <tr>
              <th>Tedarikçi</th>
              <th className="numeric">Teslimat</th>
              <th className="numeric">Ölçülen</th>
              <th className="numeric">İrsaliye</th>
              <th className="numeric">Fiilen Giren</th>
              <th className="numeric">Fark</th>
              <th>Son Teslimat</th>
            </tr>
          </thead>
          <tbody>
            {deliveryVariance.map((s) => (
              <tr key={s.supplier}>
                <td>{s.supplier}</td>
                <td className="numeric">{s.deliveryCount}</td>
                <td className="numeric">{s.measuredCount}</td>
                <td className="numeric">{s.measuredCount > 0 ? formatLiters(s.declaredLiters) : "-"}</td>
                <td className="numeric">{s.measuredCount > 0 ? formatLiters(s.acceptedLiters) : "-"}</td>
                <td className="numeric">
                  {s.measuredCount === 0 ? (
                    <span className="hint-text">ölçüm yok</span>
                  ) : (
                    <span className={`badge ${s.varianceLiters < 0 ? "critical" : "resolved"}`}>
                      {s.varianceLiters > 0 ? "+" : ""}
                      {formatLiters(s.varianceLiters)}
                      {/* Isaret zaten litrede: yuzdeyi mutlak yazmak "%-2" gibi bozuk
                          bir Turkce ifadeden kurtarir. */}
                      {s.varianceLiters !== 0 && ` (%${Math.abs(s.variancePct)})`}
                    </span>
                  )}
                </td>
                <td>{s.lastDeliveryAt ? formatDateTime(s.lastDeliveryAt) : "-"}</td>
              </tr>
            ))}
            {deliveryVariance.length === 0 && <tr><td colSpan={7} className="hint-text">Tedarikçili teslimat kaydı yok.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Tedarikçi Özeti</h3>
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

function TankCard({ tank, deliveringOrder, onChanged }: { tank: FuelTank; deliveringOrder?: FuelOrder; onChanged: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const criticalZoneHeight = tank.capacityLiters > 0 ? (tank.lowStockThresholdLiters / tank.capacityLiters) * 100 : 0;

  return (
    <div className="card tank-card">
      <div className="tank-card-head">
        <span className="tank-card-title"><span className={`fuel-dot ${tank.fuelType}`} />{FUEL_LABEL[tank.fuelType] ?? tank.fuelType}</span>
        <span className={`badge ${STATUS_BADGE[tank.status]}`}>{STATUS_LABEL[tank.status]}</span>
      </div>

      {deliveringOrder && (
        <p className="hint-text" style={{ marginTop: "0.25rem", marginBottom: 0 }}>
          🚚 Tanker dolum yapıyor — {deliveringOrder.deliveryStartedAt ? new Date(deliveringOrder.deliveryStartedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "?"}'den beri
          {" "}(otomatik seviye okuması bu süre boyunca duraklatıldı)
        </p>
      )}

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
  // Teslimat oncesi seviye varsayilan olarak tankin SU ANKI kayit seviyesidir: tanker
  // bosaltmadan once okunan gercek deger genelde budur ve operatorun elle yazmasi
  // gereksiz bir hata kaynagi olurdu. Yine de duzeltilebilir.
  const [measuredBefore, setMeasuredBefore] = useState(String(Math.round(tank.currentLiters * 100) / 100));
  const [measuredAfter, setMeasuredAfter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const bothMeasured = measuredBefore.trim() !== "" && measuredAfter.trim() !== "";
  const measuredDiff = bothMeasured ? Math.round((Number(measuredAfter) - Number(measuredBefore)) * 100) / 100 : 0;
  const previewVariance = bothMeasured && liters ? Math.round((measuredDiff - Number(liters)) * 100) / 100 : 0;

  async function submit(force = false) {
    setSubmitting(true);
    setError(null);
    if (!force) setDuplicateWarning(null);
    try {
      const res = await api.post<{ tank: FuelTank; overflow: number; variance: DeliveryVariance }>(
        `/api/fuel-stock/${tank.fuelType}/add`,
        {
          liters: Number(liters),
          supplier: supplier.trim(),
          deliveryRef: deliveryRef.trim() || undefined,
          unitCost: unitCost.trim() ? Number(unitCost) : undefined,
          note: note.trim() || undefined,
          force: force || undefined,
          // Ikisi birden girilmedikce fark hesaplanamaz; yarim olcum gondermek yerine
          // hic gondermemek, sunucunun "olculmedi" demesini saglar.
          measuredBefore: bothMeasured ? Number(measuredBefore) : undefined,
          measuredAfter: bothMeasured ? Number(measuredAfter) : undefined,
        }
      );
      if (res.variance.exceedsThreshold && res.variance.varianceLiters !== null) {
        // Bu ekran kapanmadan gosterilmeli: itiraz ancak tanker sahadayken yapilabilir.
        setError(
          `Teslimat EKSİK geldi: irsaliye ${formatLiters(Number(liters))}, tanka giren ${formatLiters(res.variance.acceptedLiters)} ` +
            `(${formatLiters(res.variance.varianceLiters)}, %${Math.abs(res.variance.variancePct ?? 0)}). Tanker ayrılmadan tutanak tutun. ` +
            `Kritik alarm oluşturuldu.`
        );
        setTimeout(onAdded, 6000);
        return;
      }
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
      <h3>{FUEL_LABEL[tank.fuelType]} — Stok Ekle</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Mevcut: {formatLiters(tank.currentLiters)} / {formatLiters(tank.capacityLiters)}
      </p>

      <label>İrsaliyedeki Miktar (L)</label>
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

      <h4 style={{ marginBottom: "0.25rem" }}>Tank Ölçümü (teslimat kabul farkı)</h4>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Tankerin boşaltmadan önceki ve sonraki tank seviyesini girerseniz, irsaliyedeki miktar ile{" "}
        <strong>fiilen giren</strong> miktar karşılaştırılır. Eksik gelen yakıt böylece teslimat anında yakalanır — aksi
        halde sonraki günlere yayılmış gizemli bir stok sapması olarak görünür. Ölçüm girilirse kayıt stoğuna{" "}
        <strong>fiilen giren</strong> miktar yazılır.
      </p>
      <div className="grid cols-2">
        <div>
          <label>Teslimat Öncesi Seviye (L)</label>
          <input type="number" min={0} step="0.01" value={measuredBefore} onChange={(e) => setMeasuredBefore(e.target.value)} />
        </div>
        <div>
          <label>Teslimat Sonrası Seviye (L)</label>
          <input type="number" min={0} step="0.01" value={measuredAfter} onChange={(e) => setMeasuredAfter(e.target.value)} />
        </div>
      </div>
      {bothMeasured ? (
        <p className={previewVariance < 0 ? "error-text" : "hint-text"}>
          Tanka giren: <strong>{formatLiters(measuredDiff)}</strong>
          {liters && Number(liters) > 0 && (
            <>
              {" · "}Fark: <strong>{previewVariance > 0 ? "+" : ""}{formatLiters(previewVariance)}</strong>
            </>
          )}
        </p>
      ) : (
        <p className="hint-text">Ölçüm girilmezse fark hesaplanamaz ve irsaliyedeki miktar kayıt stoğuna eklenir.</p>
      )}

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

const PROBE_BRAND_OPTIONS = [
  { value: "", label: "Yapılandırılmadı (simülasyon)" },
  { value: "veeder_root", label: "Veeder-Root TLS" },
  { value: "opw", label: "OPW" },
  { value: "start_italiana", label: "Start İtaliana" },
  { value: "other", label: "Diğer" },
];

function SettingsDialog({ tank, onClose, onSaved }: { tank: FuelTank; onClose: () => void; onSaved: () => void }) {
  const [capacity, setCapacity] = useState(String(tank.capacityLiters));
  const [threshold, setThreshold] = useState(String(tank.lowStockThresholdLiters));
  const [probeBrand, setProbeBrand] = useState(tank.probeBrand ?? "");
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
        probeBrand: probeBrand || null,
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
      <h3>{FUEL_LABEL[tank.fuelType]} — Tank Ayarları</h3>

      <label>Tank Kapasitesi (L)</label>
      <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />

      <label>Düşük Stok Eşiği (L)</label>
      <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />

      <label htmlFor="probe-brand">Seviye Probu Markası</label>
      <select id="probe-brand" value={probeBrand} onChange={(e) => setProbeBrand(e.target.value)}>
        {PROBE_BRAND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <p className="hint-text" style={{ marginTop: "0.25rem" }}>
        Her tank bağımsız bir marka kullanabilir. Gerçek donanım henüz bağlı değilse bu seçim yalnızca kayıt amaçlıdır.
      </p>

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

// ---------------------------------------------------------------------------

/**
 * Yakit siparisi: dusuk stok alarmi ile teslimat kaydi arasindaki eksik halka.
 *
 * Sistem siparisi OTOMATIK OLUSTURMAZ, yalnizca onerir - siparis vermek para taahhut
 * etmektir. Onerideki belirleyici sayi kalan litre degil "kac gun yeter"dir: 3.000
 * litre, gunde 500 litre satan istasyonda bir hafta, gunde 3.000 litre satanda yarim
 * gundur.
 */
interface OrderSuggestion {
  fuelType: string;
  currentLiters: number;
  capacityLiters: number;
  lowStockThresholdLiters: number;
  dailyAverageLiters: number;
  daysOfCover: number | null;
  suggestedLiters: number;
  urgent: boolean;
  openOrderLiters: number;
}

interface OrderSupplier {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
}

interface FuelOrder {
  id: number;
  fuelType: string;
  supplierId: number | null;
  supplierName: string;
  orderedLiters: number;
  receivedLiters: number | null;
  unitCost: number | null;
  expectedAt: string | null;
  status: "draft" | "sent" | "delivering" | "received" | "cancelled";
  note: string | null;
  deliveryMovementId: number | null;
  sentAt: string | null;
  deliveryStartedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

const ORDER_STATUS_LABEL: Record<FuelOrder["status"], string> = {
  draft: "Taslak",
  sent: "Gönderildi",
  delivering: "Teslimat sürüyor",
  received: "Teslim alındı",
  cancelled: "İptal",
};

const ORDER_STATUS_BADGE: Record<FuelOrder["status"], string> = {
  draft: "warning",
  sent: "info",
  delivering: "info",
  received: "resolved",
  cancelled: "critical",
};

const HISTORY_PAGE_SIZE = 10;

function FuelOrdersSection({
  suggestions,
  orders,
  suppliers,
  onChanged,
}: {
  suggestions: OrderSuggestion[];
  orders: FuelOrder[];
  suppliers: OrderSupplier[];
  onChanged: () => void;
}) {
  const stationId = useEffectiveStationId();
  const [creating, setCreating] = useState<OrderSuggestion | null>(null);
  const [receiving, setReceiving] = useState<FuelOrder | null>(null);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Gecmis (teslim alindi/iptal) zamanla buyur - bu yuzden ayri, GERCEK filtre ve
  // sayfalamaya sahip bir uctan cekilir. Acik siparisler (asagida) dogasi geregi az
  // sayida ve guncel oldugundan parent'tan gelen `orders`'tan filtrelenir, yeterlidir.
  const [historyOrders, setHistoryOrders] = useState<FuelOrder[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyStatus, setHistoryStatus] = useState<"" | "received" | "cancelled">("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");

  function updateHistoryFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setHistoryPage(1);
  }

  function loadHistory() {
    if (stationId === null) return;
    const params = new URLSearchParams();
    // Filtre "Tumu" ise dahi status parametresi ACIKCA gonderilir (received,cancelled) -
    // aksi halde sunucudan taslak/gonderildi de gelir ve total, ekranda gorunen
    // (istemci tarafinda ayiklanmis) satir sayisiyla UYUSMAZDI.
    params.set("status", historyStatus || "received,cancelled");
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    params.set("page", String(historyPage));
    params.set("pageSize", String(HISTORY_PAGE_SIZE));
    api.get<{ orders: FuelOrder[]; total: number }>(`/api/fuel-stock/orders?${params.toString()}`).then((res) => {
      setHistoryOrders(res.orders);
      setHistoryTotal(res.total);
    });
  }

  useEffect(loadHistory, [stationId, historyStatus, historyFrom, historyTo, historyPage]);

  const openOrders = orders.filter((o) => o.status === "draft" || o.status === "sent" || o.status === "delivering");

  async function act(order: FuelOrder, action: "send" | "cancel" | "start-delivery") {
    setError(null);
    try {
      await api.post(`/api/fuel-stock/orders/${order.id}/${action}`);
      onChanged();
      loadHistory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İşlem tamamlanamadı.");
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0 }}>Sipariş</h3>
        <div className="spacer" />
        <button onClick={() => setShowSuppliers(true)}>Tedarikçiler</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Yakıt</th>
            <th className="numeric">Mevcut</th>
            <th className="numeric">Günlük ortalama</th>
            <th>Kaç gün yeter</th>
            <th className="numeric">Yolda</th>
            <th className="numeric">Önerilen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((s) => (
            <tr key={s.fuelType}>
              <td>
                <strong>{FUEL_LABEL[s.fuelType] ?? s.fuelType}</strong>
              </td>
              <td className="numeric">{formatLiters(s.currentLiters)}</td>
              <td className="numeric hint-text">{s.dailyAverageLiters > 0 ? formatLiters(s.dailyAverageLiters) : "—"}</td>
              <td>
                {/* Kalan litre tek basina bir sey soylemez; karar bu sutunda verilir. */}
                {s.daysOfCover === null ? (
                  <span className="hint-text">tüketim yok</span>
                ) : (
                  <span className={`badge ${s.urgent ? "critical" : "resolved"}`}>{s.daysOfCover} gün</span>
                )}
              </td>
              <td className="numeric hint-text">{s.openOrderLiters > 0 ? formatLiters(s.openOrderLiters) : "—"}</td>
              <td className="numeric">{s.suggestedLiters > 0 ? formatLiters(s.suggestedLiters) : "—"}</td>
              <td>
                <button className="btn-sm" onClick={() => setCreating(s)} disabled={suppliers.length === 0}>
                  Sipariş Ver
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {suppliers.length === 0 && (
        <p className="hint-text">Sipariş verebilmek için önce en az bir tedarikçi tanımlayın.</p>
      )}
      {error && <p className="error-text">{error}</p>}

      {openOrders.length > 0 && (
        <>
          <h4>Açık Siparişler</h4>
          <table>
            <thead>
              <tr>
                <th>No</th>
                <th>Yakıt</th>
                <th>Tedarikçi</th>
                <th className="numeric">Miktar</th>
                <th>Beklenen</th>
                <th>Durum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {openOrders.map((o) => (
                <tr key={o.id}>
                  <td>#{o.id}</td>
                  <td>{FUEL_LABEL[o.fuelType] ?? o.fuelType}</td>
                  <td>{o.supplierName}</td>
                  <td className="numeric">{formatLiters(o.orderedLiters)}</td>
                  <td className="hint-text">{o.expectedAt ?? "—"}</td>
                  <td>
                    <span className={`badge ${ORDER_STATUS_BADGE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                  </td>
                  <td>
                    <div className="toolbar" style={{ margin: 0, gap: "0.4rem" }}>
                      {o.status === "draft" && (
                        <button className="btn-sm" onClick={() => act(o, "send")}>
                          Gönder
                        </button>
                      )}
                      {o.status === "sent" && (
                        <button className="btn-sm" onClick={() => act(o, "start-delivery")}>
                          Teslimat Başladı
                        </button>
                      )}
                      <button className="primary btn-sm" onClick={() => setReceiving(o)}>
                        Teslim Al
                      </button>
                      {o.status !== "delivering" && (
                        <button className="ghost btn-sm" onClick={() => act(o, "cancel")}>
                          İptal
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="toolbar" style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
        <h4 style={{ margin: 0 }}>Geçmiş</h4>
        <div className="spacer" />
        <select
          value={historyStatus}
          onChange={(e) => updateHistoryFilter(setHistoryStatus, e.target.value as "" | "received" | "cancelled")}
          style={{ width: 160 }}
        >
          <option value="">Tümü</option>
          <option value="received">Teslim alındı</option>
          <option value="cancelled">İptal</option>
        </select>
        <label htmlFor="fs-hist-from" style={{ margin: 0 }}>
          Başlangıç
        </label>
        <input
          id="fs-hist-from"
          type="date"
          value={historyFrom}
          onChange={(e) => updateHistoryFilter(setHistoryFrom, e.target.value)}
          style={{ maxWidth: 150 }}
        />
        <label htmlFor="fs-hist-to" style={{ margin: 0 }}>
          Bitiş
        </label>
        <input
          id="fs-hist-to"
          type="date"
          value={historyTo}
          onChange={(e) => updateHistoryFilter(setHistoryTo, e.target.value)}
          style={{ maxWidth: 150 }}
        />
      </div>
      <table>
        <thead>
          <tr>
            <th>No</th>
            <th>Yakıt</th>
            <th>Tedarikçi</th>
            <th className="numeric">Sipariş</th>
            <th className="numeric">Teslim alınan</th>
            <th>Durum</th>
          </tr>
        </thead>
        <tbody>
          {historyOrders.map((o) => (
            <tr key={o.id}>
              <td>#{o.id}</td>
              <td>{FUEL_LABEL[o.fuelType] ?? o.fuelType}</td>
              <td>{o.supplierName}</td>
              <td className="numeric">{formatLiters(o.orderedLiters)}</td>
              <td className="numeric">
                {o.receivedLiters === null ? (
                  <span className="hint-text">—</span>
                ) : (
                  /* Siparis edilenden farkli geldiyse gorunur olmali: eksik gelen
                     tanker, sizintidan sonra en yaygin kayip kaynagidir. */
                  <strong style={o.receivedLiters < o.orderedLiters ? { color: "#f87171" } : undefined}>
                    {formatLiters(o.receivedLiters)}
                  </strong>
                )}
              </td>
              <td>
                <span className={`badge ${ORDER_STATUS_BADGE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                <div className="hint-text">{formatDateTime(o.receivedAt ?? o.createdAt)}</div>
              </td>
            </tr>
          ))}
          {historyOrders.length === 0 && (
            <tr>
              <td colSpan={6} className="hint-text">
                Bu filtreye uyan sipariş yok.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <Pagination
        page={historyPage}
        pageCount={Math.max(Math.ceil(historyTotal / HISTORY_PAGE_SIZE), 1)}
        onChange={setHistoryPage}
      />

      {creating && (
        <CreateOrderDialog
          suggestion={creating}
          suppliers={suppliers.filter((s) => s.active)}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            onChanged();
          }}
        />
      )}

      {receiving && (
        <ReceiveOrderDialog
          order={receiving}
          onClose={() => setReceiving(null)}
          onReceived={() => {
            setReceiving(null);
            onChanged();
            loadHistory();
          }}
        />
      )}

      {showSuppliers && (
        <SuppliersDialog suppliers={suppliers} onClose={() => setShowSuppliers(false)} onChanged={onChanged} />
      )}
    </div>
  );
}

function CreateOrderDialog({
  suggestion,
  suppliers,
  onClose,
  onCreated,
}: {
  suggestion: OrderSuggestion;
  suppliers: OrderSupplier[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? 0);
  const [liters, setLiters] = useState(suggestion.suggestedLiters > 0 ? String(suggestion.suggestedLiters) : "");
  const [unitCost, setUnitCost] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/fuel-stock/orders", {
        fuelType: suggestion.fuelType,
        supplierId,
        liters: Number(liters),
        unitCost: unitCost ? Number(unitCost) : undefined,
        expectedAt: expectedAt || undefined,
        note: note.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sipariş oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>{FUEL_LABEL[suggestion.fuelType] ?? suggestion.fuelType} Siparişi</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Mevcut {formatLiters(suggestion.currentLiters)} / {formatLiters(suggestion.capacityLiters)} kapasite
          {suggestion.daysOfCover !== null && ` · bu hızla ${suggestion.daysOfCover} gün yeter`}
        </p>

        <label>Tedarikçi</label>
        <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.email ? "" : " (e-posta yok)"}
            </option>
          ))}
        </select>

        <label>Miktar (L)</label>
        <input type="number" min={1} step={1} value={liters} onChange={(e) => setLiters(e.target.value)} autoFocus />

        <label>Anlaşılan Birim Fiyat (TL/L, opsiyonel)</label>
        <input type="number" min={0} step={0.0001} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />

        <label>Beklenen Teslim Tarihi (opsiyonel)</label>
        <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />

        <label>Not (opsiyonel)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !liters || !supplierId}>
            {busy ? "Kaydediliyor..." : "Siparişi Oluştur"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Teslim alma, mevcut teslimat yolunu kullanir: irsaliyede yazan miktar ile tanka
 * fiilen giren miktar AYRI sorulur ve kabul farki oradan hesaplanir.
 */
function ReceiveOrderDialog({ order, onClose, onReceived }: { order: FuelOrder; onClose: () => void; onReceived: () => void }) {
  const [liters, setLiters] = useState(String(order.orderedLiters));
  const [deliveryRef, setDeliveryRef] = useState("");
  const [measuredBefore, setMeasuredBefore] = useState("");
  const [measuredAfter, setMeasuredAfter] = useState("");
  const [unitCost, setUnitCost] = useState(order.unitCost?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(force = false) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/fuel-stock/orders/${order.id}/receive`, {
        liters: Number(liters),
        deliveryRef: deliveryRef.trim() || undefined,
        unitCost: unitCost ? Number(unitCost) : undefined,
        measuredBefore: measuredBefore ? Number(measuredBefore) : undefined,
        measuredAfter: measuredAfter ? Number(measuredAfter) : undefined,
        force,
      });
      onReceived();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Teslimat kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>#{order.id} Teslim Al</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          {order.supplierName} · {formatLiters(order.orderedLiters)} sipariş edilmişti.
        </p>

        <label>İrsaliyede Yazan Miktar (L)</label>
        <input type="number" min={1} step={0.01} value={liters} onChange={(e) => setLiters(e.target.value)} autoFocus />

        <label>İrsaliye No</label>
        <input value={deliveryRef} onChange={(e) => setDeliveryRef(e.target.value)} maxLength={60} />

        <label>Birim Maliyet (TL/L, opsiyonel)</label>
        <input type="number" min={0} step={0.0001} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />

        {/* Ikisi de girilirse tanka fiilen ne girdigi olculur ve eksik gelen tanker
            teslimat aninda yakalanir; girilmezse irsaliye rakami esas alinir. */}
        <div className="grid cols-2" style={{ alignItems: "start" }}>
          <div>
            <label>Teslimat Öncesi Tank (L)</label>
            <input type="number" min={0} step={0.01} value={measuredBefore} onChange={(e) => setMeasuredBefore(e.target.value)} />
          </div>
          <div>
            <label>Teslimat Sonrası Tank (L)</label>
            <input type="number" min={0} step={0.01} value={measuredAfter} onChange={(e) => setMeasuredAfter(e.target.value)} />
          </div>
        </div>
        <p className="hint-text">
          İkisini de girerseniz eksik gelen yakıt teslimat anında yakalanır. Boş bırakılırsa irsaliyedeki miktar esas alınır.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          {error?.includes("irsaliye") && (
            <button onClick={() => submit(true)} disabled={busy}>
              Yine de Kaydet
            </button>
          )}
          <button className="primary" onClick={() => submit()} disabled={busy || !liters}>
            {busy ? "Kaydediliyor..." : "Teslimatı Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SuppliersDialog({
  suppliers,
  onClose,
  onChanged,
}: {
  suppliers: OrderSupplier[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/fuel-stock/suppliers", {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Tedarikçi eklenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: OrderSupplier) {
    await api.patch(`/api/fuel-stock/suppliers/${s.id}`, { active: !s.active }).catch(() => {});
    onChanged();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-lg" onClick={(e) => e.stopPropagation()}>
        <h3>Tedarikçiler</h3>
        {/* Teslimat kaydindaki tedarikci alani serbest metin olarak kaliyor; bu liste
            yalnizca siparisin KIME gonderilecegini bilmek icin. */}
        <p className="hint-text" style={{ marginTop: 0 }}>
          Sipariş e-postası buradaki adrese gider. E-postası olmayan tedarikçiye sipariş yine kaydedilir, sadece
          e-posta gönderilmez.
        </p>

        <table>
          <thead>
            <tr>
              <th>Ad</th>
              <th>E-posta</th>
              <th>Telefon</th>
              <th>Durum</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="hint-text">{s.email ?? "—"}</td>
                <td className="hint-text">{s.phone ?? "—"}</td>
                <td>
                  <span className={`badge ${s.active ? "resolved" : "critical"}`}>{s.active ? "Aktif" : "Pasif"}</span>
                </td>
                <td>
                  <button className="ghost btn-sm" onClick={() => toggle(s)}>
                    {s.active ? "Pasife Al" : "Aktif Et"}
                  </button>
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td colSpan={5} className="hint-text">
                  Henüz tedarikçi tanımlanmamış.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h4>Yeni Tedarikçi</h4>
        <div className="grid cols-2" style={{ alignItems: "start" }}>
          <div>
            <label>Ad</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div>
            <label>E-posta</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="siparis@tedarikci.com" />
          </div>
        </div>
        <label>Telefon</label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Kapat
          </button>
          <div className="spacer" />
          <button className="primary" onClick={create} disabled={busy || name.trim().length < 2}>
            Ekle
          </button>
        </div>
      </div>
    </div>
  );
}
