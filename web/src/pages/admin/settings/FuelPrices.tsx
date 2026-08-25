import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEscapeKey } from "../../../shared/useEscapeKey";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import { FUEL_LABEL, formatCurrency, formatDateTime } from "../../../shared/format";
import type { FuelPrice, PriceGuardWarning } from "../../../shared/types";

interface ScheduledPriceChange {
  id: number;
  fuelType: string;
  pricePerLiter: number;
  scheduledFor: string;
  status: "pending" | "applied" | "cancelled";
  createdAt: string;
  appliedAt: string | null;
}

export default function FuelPrices() {
  const stationId = useEffectiveStationId();
  const [prices, setPrices] = useState<FuelPrice[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduledPriceChange[]>([]);
  const [scheduleFuelType, setScheduleFuelType] = useState("");
  const [schedulePrice, setSchedulePrice] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);

  function load() {
    if (stationId === null) return;
    api.get<{ fuelPrices: FuelPrice[] }>("/api/settings/fuel-prices").then((res) => setPrices(res.fuelPrices));
    api.get<{ schedules: ScheduledPriceChange[] }>("/api/settings/fuel-prices/scheduled").then((res) => setSchedules(res.schedules));
  }
  useEffect(load, [stationId]);

  /**
   * Fat-finger onayi. Sunucu olagandisi bir fiyat degisikliginde 409 + uyari detayi
   * dondurur (bkz. server/src/services/priceGuardService.ts); ekran rakami kullaniciya
   * gosterip acik onay ister. Onay verilirse ayni istek force ile tekrarlanir.
   */
  const [guard, setGuard] = useState<{ warning: PriceGuardWarning; confirm: () => void } | null>(null);

  function extractGuard(err: unknown): PriceGuardWarning | null {
    if (!(err instanceof ApiError) || err.status !== 409 || !err.details || typeof err.details !== "object") return null;
    const d = err.details as { priceGuard?: PriceGuardWarning };
    return d.priceGuard ?? null;
  }

  async function submitSchedule(force = false) {
    setScheduleError(null);
    const price = Number(schedulePrice);
    if (!scheduleFuelType || !schedulePrice || Number.isNaN(price) || price <= 0 || !scheduleAt) {
      setScheduleError("Yakıt tipi, fiyat ve tarih/saat gereklidir.");
      return;
    }
    setScheduleSubmitting(true);
    try {
      await api.post("/api/settings/fuel-prices/scheduled", {
        fuelType: scheduleFuelType,
        pricePerLiter: price,
        scheduledFor: new Date(scheduleAt).toISOString(),
        force: force || undefined,
      });
      setGuard(null);
      setScheduleFuelType("");
      setSchedulePrice("");
      setScheduleAt("");
      load();
    } catch (err) {
      const warning = extractGuard(err);
      if (warning) {
        setGuard({ warning, confirm: () => void submitSchedule(true) });
        return;
      }
      setScheduleError(err instanceof ApiError ? err.message : "Planlanamadı.");
    } finally {
      setScheduleSubmitting(false);
    }
  }

  async function cancelScheduleRow(id: number) {
    setScheduleError(null);
    try {
      await api.delete(`/api/settings/fuel-prices/scheduled/${id}`);
      load();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "İptal edilemedi.");
    }
  }

  const pendingSchedules = schedules.filter((s) => s.status === "pending");

  async function save(fuelType: string, force = false) {
    const raw = edits[fuelType];
    const value = Number(raw);
    setError(null);
    setSavedMsg(null);
    if (!raw || Number.isNaN(value) || value <= 0) {
      setError("Geçerli bir fiyat giriniz.");
      return;
    }
    try {
      await api.patch(`/api/settings/fuel-prices/${fuelType}`, { pricePerLiter: value, force: force || undefined });
      setGuard(null);
      setSavedMsg(`${FUEL_LABEL[fuelType] ?? fuelType} fiyatı güncellendi.`);
      load();
    } catch (err) {
      const warning = extractGuard(err);
      if (warning) {
        setGuard({ warning, confirm: () => void save(fuelType, true) });
        return;
      }
      setError(err instanceof ApiError ? err.message : "Güncelleme başarısız.");
    }
  }

  return (
    <div className="settings-page">
      {guard && <PriceGuardDialog warning={guard.warning} onConfirm={guard.confirm} onCancel={() => setGuard(null)} />}
      <div className="card settings-card">
        <div className="card-head">
          <h3>Yakıt Fiyatları</h3>
        </div>
        {prices.map((p) => (
          <div key={p.fuelType} className="fuel-price-row">
            <span className="fuel-price-label">{p.label}</span>
            <input
              type="number"
              step="0.01"
              min="0"
              defaultValue={p.pricePerLiter}
              onChange={(e) => setEdits((prev) => ({ ...prev, [p.fuelType]: e.target.value }))}
            />
            <span className="hint-text">TL/L</span>
            <button onClick={() => save(p.fuelType)}>Kaydet</button>
          </div>
        ))}
        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="success-text">{savedMsg}</p>}
        <p className="hint-text" style={{ marginTop: "0.75rem" }}>
          Resmi fiyatları elle karşılaştırmak isterseniz:{" "}
          <a
            href="https://lisans.epdk.gov.tr/epvys-web/faces/pages/lisans/petrolBayilik/pompaFiyatlariOzetSorgula.xhtml"
            target="_blank"
            rel="noopener noreferrer"
          >
            EPDK İstasyon Pompa Fiyatları sorgu sayfası
          </a>{" "}
          (il/ilçe/bayi bazında; CAPTCHA korumalı olduğundan otomatik çekilemiyor, elle sorgulanır).
        </p>

        <h4>Zamanlanmış Fiyat Değişikliği</h4>
        <p className="hint-text">İleri bir tarih/saat belirleyin, o an geldiğinde fiyat otomatik devreye girer.</p>
        <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <select value={scheduleFuelType} onChange={(e) => setScheduleFuelType(e.target.value)}>
            <option value="">Yakıt tipi seçin</option>
            {prices.map((p) => (
              <option key={p.fuelType} value={p.fuelType}>{p.label}</option>
            ))}
          </select>
          <input type="number" step="0.01" min="0" placeholder="Yeni fiyat (TL/L)" value={schedulePrice} onChange={(e) => setSchedulePrice(e.target.value)} style={{ width: "10rem" }} />
          <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          {/* Ok fonksiyonu SART: dogrudan baglansaydi tiklama olayi `force` parametresine
              gecer ve nesne truthy oldugu icin her planlama guvenlik kontrolunu atlardi. */}
          <button className="primary" onClick={() => void submitSchedule()} disabled={scheduleSubmitting}>
            {scheduleSubmitting ? "Planlanıyor..." : "Planla"}
          </button>
        </div>
        {scheduleError && <p className="error-text">{scheduleError}</p>}

        {pendingSchedules.length > 0 && (
          <table style={{ marginTop: "0.75rem" }}>
            <thead>
              <tr><th>Yakıt</th><th className="numeric">Yeni Fiyat</th><th>Planlanan Zaman</th><th></th></tr>
            </thead>
            <tbody>
              {pendingSchedules.map((s) => (
                <tr key={s.id}>
                  <td>{FUEL_LABEL[s.fuelType] ?? s.fuelType}</td>
                  <td className="numeric">{formatCurrency(s.pricePerLiter)}</td>
                  <td>{formatDateTime(s.scheduledFor)}</td>
                  <td><button onClick={() => cancelScheduleRow(s.id)}>İptal Et</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * Onay penceresi. Amac kullaniciyi durdurmak degil, RAKAMI ONA GOSTERMEK: yanlislikla
 * yazilan bir sayi ile bilerek girilen bir sayi arasindaki fark ancak insanin kendisi
 * tarafindan bilinebilir.
 */
function PriceGuardDialog({
  warning,
  onConfirm,
  onCancel,
}: {
  warning: PriceGuardWarning;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscapeKey(onCancel);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="price-guard-title"
    >
      <div className="card" style={{ width: "min(520px, 92vw)", borderColor: "#f87171" }}>
        <h3 id="price-guard-title" style={{ marginTop: 0, color: "#f87171" }}>
          Fiyat Değişikliğini Onaylayın
        </h3>

        <div className="grid cols-2" style={{ marginBottom: "0.5rem" }}>
          <div>
            <span className="label">Mevcut fiyat</span>
            <div className="value" style={{ fontSize: "1.4rem" }}>{formatCurrency(warning.currentPrice)}</div>
          </div>
          <div>
            <span className="label">Yeni fiyat</span>
            <div className="value" style={{ fontSize: "1.4rem", color: "#f87171" }}>{formatCurrency(warning.newPrice)}</div>
          </div>
        </div>

        {warning.exceedsThreshold && (
          <p className="error-text">
            Değişim: <strong>%{Math.abs(warning.changePct).toFixed(2)}</strong> {warning.changePct > 0 ? "artış" : "azalış"}.
            Bu olağandışı bir sıçrama — ondalık hatası olabilir (örn. 54,20 yerine 5,42).
          </p>
        )}
        {warning.belowCost && warning.averageCostPerLiter !== null && (
          <p className="error-text">
            Yeni fiyat, ortalama alış maliyetinin ({formatCurrency(warning.averageCostPerLiter)}/L) <strong>altında</strong> —
            zararına satış.
          </p>
        )}
        <p className="hint-text">
          İstasyon personelsiz çalıştığı için yanlış bir fiyatı fark edecek kimse yoktur. Rakamı doğruladıysanız onaylayın.
        </p>

        <div className="toolbar" style={{ marginTop: "1.25rem", marginBottom: 0 }}>
          <button type="button" onClick={onCancel} autoFocus>
            Vazgeç
          </button>
          <div className="spacer" />
          <button type="button" className="danger" onClick={onConfirm}>
            Evet, Bu Fiyatı Uygula
          </button>
        </div>
      </div>
    </div>
  );
}
