import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, formatDateTime, formatLiters } from "../../shared/format";
import type { FuelType, Pump } from "../../shared/types";

/**
 * Pompa sayaci (totalizator) mutabakati.
 *
 * Yakit Sapma ekrani TANKI izler ve "yakit eksildi" der; ama tanktan mi sizdi yoksa
 * pompadan kayit disi mi akitildi ayirt etmez. Bu ekran o ayrimi yapar: sayacin
 * dagittigi ile sistemin kaydettigi karsilastirilir.
 *
 * Kalibrasyon ekranindan (Pompalar > kalibrasyon) FARKLIDIR: orada sayacin DOGRU olcup
 * olcmedigi test edilir; burada sayac kusursuz calissa bile kayit disi bir cekim gorunur.
 */

interface TotalizerStatus {
  pumpId: number;
  pumpLabel: string;
  fuelType: FuelType;
  lastTotalizerLiters: number | null;
  lastMeasuredAt: string | null;
  recordedSinceLiters: number;
  cumulativeVarianceLiters: number;
}

interface TotalizerReading {
  id: number;
  pumpId: number;
  pumpLabel?: string;
  fuelType: FuelType;
  totalizerLiters: number;
  previousTotalizerLiters: number | null;
  dispensedLiters: number;
  recordedLiters: number;
  varianceLiters: number;
  variancePct: number;
  isMeterReset: boolean;
  alarmId: number | null;
  note: string | null;
  measuredAt: string;
  username: string | null;
}

interface TotalizerSettings {
  thresholdPct: number;
  minLiters: number;
}

interface Payload {
  pumps: TotalizerStatus[];
  readings: TotalizerReading[];
  settings: TotalizerSettings;
}

function formatVariance(liters: number): string {
  const sign = liters > 0 ? "+" : "";
  return `${sign}${formatLiters(liters)}`;
}

/** Arti: pompa kayittan fazla dagitmis (kayit disi cekim). Eksi: sistem fazla kaydetmis. */
function varianceTone(liters: number, alarmed: boolean): string {
  if (alarmed) return "critical";
  return liters === 0 ? "resolved" : "warning";
}

export default function PumpTotalizers() {
  const stationId = useEffectiveStationId();
  const [pumps, setPumps] = useState<Pump[]>([]);
  const [data, setData] = useState<Payload | null>(null);

  function load() {
    if (stationId === null) return;
    api.get<Payload>("/api/pumps/totalizers").then(setData);
    api.get<{ pumps: Pump[] }>("/api/pumps").then((r) => setPumps(r.pumps));
  }
  useEffect(load, [stationId]);

  return (
    <div>
      <h2>Pompa Sayaçları</h2>
      <p className="hint-text">
        Her pompanın sıfırlanamayan bir toplam sayacı vardır. Vardiya/gün sonunda okunan değer, iki okuma arasında
        sisteme kaydedilen satışla karşılaştırılır. Tank ölçümü "yakıt eksildi" der; bu ekran <strong>nerede</strong>
        eksildiğini söyler.
      </p>

      <div className="grid cols-2">
        <NewReadingCard pumps={pumps} onSaved={load} />
        <ThresholdCard settings={data?.settings ?? null} onSaved={load} />
      </div>

      <h3>Pompa Durumu</h3>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Pompa</th>
              <th>Yakıt</th>
              <th className="numeric">Son sayaç</th>
              <th>Son okuma</th>
              <th className="numeric">Okumadan beri kaydedilen</th>
              <th className="numeric">Kümülatif sapma</th>
            </tr>
          </thead>
          <tbody>
            {(data?.pumps ?? []).map((p) => (
              <tr key={`${p.pumpId}-${p.fuelType}`}>
                <td>
                  <strong>{p.pumpLabel}</strong>
                </td>
                <td>{FUEL_LABEL[p.fuelType]}</td>
                <td className="numeric">
                  {p.lastTotalizerLiters === null ? <span className="hint-text">okuma yok</span> : formatLiters(p.lastTotalizerLiters)}
                </td>
                <td className="hint-text">{p.lastMeasuredAt ? formatDateTime(p.lastMeasuredAt) : "—"}</td>
                {/* Bir sonraki okumada sayacin bu kadar artmasi bekleniyor - personel
                    sayaca bakmadan once ne gormesi gerektigini bilir. */}
                <td className="numeric">{formatLiters(p.recordedSinceLiters)}</td>
                <td className="numeric">
                  {/* Tek okumadaki salinim olcum hatasidir; surekli ayni yonde biriken
                      toplam sistematik bir sorundur. */}
                  <span className={`badge ${varianceTone(p.cumulativeVarianceLiters, false)}`}>
                    {formatVariance(p.cumulativeVarianceLiters)}
                  </span>
                </td>
              </tr>
            ))}
            {data !== null && data.pumps.length === 0 && (
              <tr>
                <td colSpan={6} className="hint-text">
                  Tanımlı pompa yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3>Okuma Geçmişi</h3>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Okuma tarihi</th>
              <th>Pompa</th>
              <th>Yakıt</th>
              <th className="numeric">Sayaç</th>
              <th className="numeric">Pompa dağıttı</th>
              <th className="numeric">Sistem kaydetti</th>
              <th>Fark</th>
              <th>Okuyan</th>
              <th>Not</th>
            </tr>
          </thead>
          <tbody>
            {(data?.readings ?? []).map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.measuredAt)}</td>
                <td>{r.pumpLabel ?? `#${r.pumpId}`}</td>
                <td>{FUEL_LABEL[r.fuelType]}</td>
                <td className="numeric">{formatLiters(r.totalizerLiters)}</td>
                <td className="numeric">{formatLiters(r.dispensedLiters)}</td>
                <td className="numeric">{formatLiters(r.recordedLiters)}</td>
                <td>
                  {r.isMeterReset ? (
                    <span className="badge info">sayaç değişimi</span>
                  ) : (
                    <>
                      <span className={`badge ${varianceTone(r.varianceLiters, r.alarmId !== null)}`}>
                        {formatVariance(r.varianceLiters)}
                      </span>
                      {r.varianceLiters !== 0 && <div className="hint-text">%{r.variancePct}</div>}
                    </>
                  )}
                </td>
                <td className="hint-text">{r.username ?? "—"}</td>
                <td className="hint-text">{r.note ?? "—"}</td>
              </tr>
            ))}
            {data !== null && data.readings.length === 0 && (
              <tr>
                <td colSpan={9} className="hint-text">
                  Henüz sayaç okuması girilmemiş. İlk okuma bir başlangıç noktası oluşturur; karşılaştırma ikinci
                  okumadan itibaren yapılır.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewReadingCard({ pumps, onSaved }: { pumps: Pump[]; onSaved: () => void }) {
  const [pumpId, setPumpId] = useState<number | "">("");
  const [fuelType, setFuelType] = useState<FuelType | "">("");
  const [totalizer, setTotalizer] = useState("");
  const [note, setNote] = useState("");
  const [meterReset, setMeterReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ variance: number; alarmRaised: boolean } | null>(null);

  const selected = pumps.find((p) => p.id === pumpId) ?? null;
  const fuelOptions = selected?.fuelTypes ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pumpId === "" || fuelType === "") return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ reading: TotalizerReading; alarmRaised: boolean }>(`/api/pumps/${pumpId}/totalizers`, {
        fuelType,
        totalizerLiters: Number(totalizer),
        note: note.trim() || undefined,
        meterReset: meterReset || undefined,
      });
      setResult({ variance: res.reading.varianceLiters, alarmRaised: res.alarmRaised });
      setTotalizer("");
      setNote("");
      setMeterReset(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Okuma kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Yeni Sayaç Okuması</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Pompanın toplam sayacındaki değeri olduğu gibi girin (sıfırlanmaz, hep artar).
      </p>

      <label htmlFor="tot-pump">Pompa</label>
      <select
        id="tot-pump"
        value={pumpId}
        onChange={(e) => {
          setPumpId(e.target.value ? Number(e.target.value) : "");
          setFuelType("");
        }}
        required
      >
        <option value="">Seçin</option>
        {pumps.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <label htmlFor="tot-fuel">Yakıt tipi</label>
      <select id="tot-fuel" value={fuelType} onChange={(e) => setFuelType(e.target.value as FuelType)} required disabled={!selected}>
        <option value="">{selected ? "Seçin" : "Önce pompa seçin"}</option>
        {fuelOptions.map((f) => (
          <option key={f} value={f}>
            {FUEL_LABEL[f]}
          </option>
        ))}
      </select>

      <label htmlFor="tot-value">Sayaç değeri (L)</label>
      <input
        id="tot-value"
        type="number"
        min={0}
        step={0.01}
        value={totalizer}
        onChange={(e) => setTotalizer(e.target.value)}
        placeholder="ör. 126430.55"
        required
      />

      {/* Geri giden bir okuma sessizce kabul edilmez; sayac degistiyse bunu BEYAN
          etmek gerekir - aksi halde eski ve yeni sayacin farki "kayip" sayilirdi. */}
      <label className="check">
        <input type="checkbox" checked={meterReset} onChange={(e) => setMeterReset(e.target.checked)} />
        Sayaç değiştirildi / sıfırlandı (bu okuma yeni bir başlangıç noktasıdır)
      </label>

      <label htmlFor="tot-note">Not (opsiyonel)</label>
      <input id="tot-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ör. Vardiya sonu okuması" maxLength={300} />

      {error && <p className="error-text">{error}</p>}
      {result && (
        <p className={result.alarmRaised ? "error-text" : "hint-text"}>
          Okuma kaydedildi. Fark: {formatVariance(result.variance)}.
          {result.alarmRaised
            ? " Eşik aşıldığı için kritik alarm oluşturuldu — Alarm Merkezi'nden takip edin."
            : " Eşiğin altında, alarm oluşturulmadı."}
        </p>
      )}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Kaydediliyor..." : "Okumayı Kaydet"}
      </button>
    </form>
  );
}

function ThresholdCard({ settings, onSaved }: { settings: TotalizerSettings | null; onSaved: () => void }) {
  const [thresholdPct, setThresholdPct] = useState("");
  const [minLiters, setMinLiters] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setThresholdPct(String(settings.thresholdPct));
      setMinLiters(String(settings.minLiters));
    }
  }, [settings]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/pumps/totalizers/settings", {
        thresholdPct: Number(thresholdPct),
        minLiters: Number(minLiters),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Alarm Eşiği</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Pompa sayacı yasal olarak ±%0,5 içinde çalışmak zorundadır; buradaki fark ~sıfır beklenir. İki koşul birden
        aşılırsa alarm üretilir.
      </p>

      <label htmlFor="tot-pct">Oran eşiği (dağıtılan hacmin %'si)</label>
      <input id="tot-pct" type="number" min={0} max={100} step={0.01} value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} />

      <label htmlFor="tot-min">En düşük fark (L)</label>
      <input id="tot-min" type="number" min={0} step={1} value={minLiters} onChange={(e) => setMinLiters(e.target.value)} />
      <p className="hint-text">Küçük pencerelerde birkaç litrelik okuma hatası yüzde olarak büyük görünür; bu taban onu eler.</p>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="hint-text">Kaydedildi.</p>}

      <button type="submit" disabled={saving}>
        {saving ? "Kaydediliyor..." : "Eşiği Kaydet"}
      </button>
    </form>
  );
}
