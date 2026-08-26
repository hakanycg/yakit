import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { FUEL_LABEL, formatDateTime, formatLiters } from "../../shared/format";
import { AlertIcon, FuelIcon } from "../../shared/icons";
import type { FuelTank, FuelTankReading, FuelType, VarianceSettings, VarianceSummaryRow } from "../../shared/types";

/**
 * Yakit sapma takibi: fiziksel tank olcumu ile kayit stogunun karsilastirilmasi.
 * Personelsiz istasyonda sizintiyi, ayari kaymis pompayi veya kayit disi cekimi
 * yakalamanin tek yolu bu ekrandir.
 */

type ReadingsResponse = {
  readings: FuelTankReading[];
  summary: VarianceSummaryRow[];
  settings: VarianceSettings;
  /** Tank dibi su uyari esigi (mm) - istasyon bazinda ayarlanabilir. */
  waterThresholdMm: number;
};

/** Sapmanin okunusu: eksi litre kayip, arti litre fazladir. */
function varianceTone(liters: number, thresholdReached: boolean): string {
  if (liters === 0) return "resolved";
  return thresholdReached ? "critical" : "warning";
}

function formatVariance(liters: number): string {
  const sign = liters > 0 ? "+" : "";
  return `${sign}${formatLiters(liters)}`;
}

export default function FuelVariance() {
  const stationId = useEffectiveStationId();
  const [tanks, setTanks] = useState<FuelTank[]>([]);
  const [data, setData] = useState<ReadingsResponse | null>(null);
  const [filter, setFilter] = useState("");

  function load() {
    if (stationId === null) return;
    api.get<{ tanks: FuelTank[] }>("/api/fuel-stock").then((res) => setTanks(res.tanks));
    const query = filter ? `?fuelType=${filter}` : "";
    api.get<ReadingsResponse>(`/api/fuel-stock/readings${query}`).then(setData);
  }

  useEffect(load, [stationId, filter]);

  const csvHref = appendStationParam(`/api/fuel-stock/readings/export.csv${filter ? `?fuelType=${filter}` : ""}`);

  return (
    <div>
      <h2>Yakıt Sapma Takibi</h2>
      <p className="hint-text">
        Tanktaki fiziksel ölçümü kayıttaki stokla karşılaştırır. Sürekli aynı yönde biriken bir fark sızıntıya,
        ayarı kaymış bir pompa sayacına veya kayıt dışı çekime işaret eder.
      </p>

      <VarianceSummary summary={data?.summary ?? []} settings={data?.settings ?? null} />

      <div className="grid cols-2">
        <NewReadingCard tanks={tanks} onSaved={load} />
        <ThresholdCard settings={data?.settings ?? null} onSaved={load} />
      </div>

      <div className="toolbar">
        <h3 style={{ margin: 0 }}>Ölçüm Geçmişi</h3>
        <div className="spacer" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Yakıt tipi filtresi" style={{ width: 200 }}>
          <option value="">Tüm yakıt tipleri</option>
          {(["benzin", "motorin", "lpg"] as FuelType[]).map((f) => (
            <option key={f} value={f}>
              {FUEL_LABEL[f]}
            </option>
          ))}
        </select>
        <a href={csvHref}>
          <button type="button">CSV İndir</button>
        </a>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Ölçüm tarihi</th>
              <th>Yakıt</th>
              <th>Fiziksel ölçüm</th>
              <th>Kayıttaki stok</th>
              <th>Sapma</th>
              <th>Sıcaklık etkisi</th>
              <th>Su (mm)</th>
              <th>Hareket hacmi</th>
              <th>Oran</th>
              <th>Ölçen</th>
              <th>Not</th>
            </tr>
          </thead>
          <tbody>
            {(data?.readings ?? []).map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.measuredAt)}</td>
                <td>{FUEL_LABEL[r.fuelType]}</td>
                <td>{formatLiters(r.measuredLiters)}</td>
                <td>{formatLiters(r.bookLiters)}</td>
                <td>
                  {/* Gosterilen sapma, sicaklik ayiklandiktan SONRAKI sapmadir - alarm
                      karari da buna bakar. Duzeltme yapilamadiysa ham fark gosterilir
                      ve yan sutunda bunun neden duzeltilmedigi yazar. */}
                  <span
                    className={`badge ${varianceTone(r.adjustedVarianceLiters ?? r.varianceLiters, r.alarmId !== null)}`}
                  >
                    {formatVariance(r.adjustedVarianceLiters ?? r.varianceLiters)}
                  </span>
                  {r.adjustedVarianceLiters !== null && r.adjustedVarianceLiters !== r.varianceLiters && (
                    <div className="hint-text">ham: {formatVariance(r.varianceLiters)}</div>
                  )}
                </td>
                <td>
                  {r.temperatureCorrectionLiters === null ? (
                    /* "Duzeltme sifir cikti" ile "duzeltme yapilamadi" ayni sey degil:
                       duzeltilmemis bir sapma duzeltilmis sanilmamali. */
                    <span className="hint-text">düzeltilmedi</span>
                  ) : (
                    <>
                      {formatVariance(r.temperatureCorrectionLiters)}
                      {r.temperatureCelsius !== null && <div className="hint-text">{r.temperatureCelsius} °C</div>}
                    </>
                  )}
                </td>
                <td>
                  {r.waterLevelMm === null ? (
                    <span className="hint-text">ölçülmedi</span>
                  ) : (
                    <span className={`badge ${r.waterLevelMm >= (data?.waterThresholdMm ?? 25) ? "critical" : "resolved"}`}>
                      {r.waterLevelMm} mm
                    </span>
                  )}
                </td>
                <td>{formatLiters(r.throughputLiters)}</td>
                <td>%{r.variancePct}</td>
                <td>
                  {r.source === "auto" ? (
                    <>
                      <span className="badge resolved">Seviye probu</span>
                      {r.temperatureCelsius !== null && <div className="hint-text">{r.temperatureCelsius} °C</div>}
                    </>
                  ) : (
                    (r.username ?? "—")
                  )}
                </td>
                <td>{r.note ?? "—"}</td>
              </tr>
            ))}
            {data !== null && data.readings.length === 0 && (
              <tr>
                <td colSpan={11} className="hint-text">
                  Henüz ölçüm girilmemiş. İlk ölçüm bir referans noktası oluşturur; sapma oranı ikinci ölçümden
                  itibaren anlamlı olur.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Kumulatif sapma. Tek olcumdeki arti/eksi salinimlar (olcum hassasiyeti, sicaklik)
 * uzun vadede birbirini goturur; SUREKLI ayni yonde biriken bir toplam ise gercek
 * bir kayiptir. Ozet bu yuzden son olcume degil kumulatife bakar.
 *
 * Kirmizi renk yalnizca kumulatif kayip istasyonun kendi esigini astiginda kullanilir:
 * her eksi degeri kirmizi gostermek, tolerans icindeki normal farklari da alarm gibi
 * gosterip uyarinin anlamini yitirmesine yol acardi.
 */
function VarianceSummary({ summary, settings }: { summary: VarianceSummaryRow[]; settings: VarianceSettings | null }) {
  if (summary.length === 0) return null;
  const thresholdPct = settings?.thresholdPct ?? 0.5;
  const minLiters = settings?.minLiters ?? 50;

  return (
    <div className="grid stats-grid">
      {summary.map((s) => {
        const loss = s.totalVarianceLiters < 0;
        const overThreshold =
          Math.abs(s.totalVarianceLiters) >= minLiters && Math.abs(s.netVariancePct) >= thresholdPct;
        const alarming = loss && overThreshold;
        return (
          <div className="card stat dash-stat" key={s.fuelType}>
            <div
              className="stat-icon"
              style={
                alarming
                  ? { background: "rgba(248,113,113,0.15)", color: "#f87171" }
                  : { background: "rgba(58,160,255,0.15)", color: "var(--accent)" }
              }
            >
              {alarming ? <AlertIcon /> : <FuelIcon />}
            </div>
            <div className="stat-body">
              <span className="label">{FUEL_LABEL[s.fuelType]} — kümülatif sapma</span>
              <span className="value" style={alarming ? { color: "#f87171" } : undefined}>
                {formatVariance(s.totalVarianceLiters)}
              </span>
              <span className="stat-caption">
                {s.readingCount} ölçüm · {formatLiters(s.totalThroughputLiters)} hareket · net %{s.netVariancePct}
                {alarming ? " · eşik üstü" : ""}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Fiziksel olcum girisi. Tankin o anki kayit degeri, kullanicinin farki daha girmeden gormesi icin gosterilir. */
function NewReadingCard({ tanks, onSaved }: { tanks: FuelTank[]; onSaved: () => void }) {
  const [fuelType, setFuelType] = useState<FuelType>("motorin");
  const [measured, setMeasured] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ variance: number; alarmRaised: boolean; waterAlarmRaised: boolean } | null>(null);
  const [waterMm, setWaterMm] = useState("");
  const [temperature, setTemperature] = useState("");

  const tank = tanks.find((t) => t.fuelType === fuelType);
  const measuredNum = Number(measured);
  const preview =
    tank && measured !== "" && Number.isFinite(measuredNum)
      ? Math.round((measuredNum - tank.currentLiters) * 100) / 100
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ reading: FuelTankReading; alarmRaised: boolean; waterAlarmRaised: boolean }>(
        `/api/fuel-stock/${fuelType}/reading`,
        {
          measuredLiters: measuredNum,
          note: note.trim() || undefined,
          waterLevelMm: waterMm === "" ? undefined : Number(waterMm),
          temperatureCelsius: temperature === "" ? undefined : Number(temperature),
        }
      );
      setResult({
        variance: res.reading.adjustedVarianceLiters ?? res.reading.varianceLiters,
        alarmRaised: res.alarmRaised,
        waterAlarmRaised: res.waterAlarmRaised,
      });
      setMeasured("");
      setNote("");
      setWaterMm("");
      setTemperature("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ölçüm kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Yeni Fiziksel Ölçüm</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Daldırma çubuğu veya seviye probuyla okunan gerçek litreyi girin. Kayıt stoğu bu ölçüme eşitlenir, fark
        denetim izine düzeltme olarak yazılır.
      </p>

      <label htmlFor="var-fuel">Yakıt tipi</label>
      <select id="var-fuel" value={fuelType} onChange={(e) => setFuelType(e.target.value as FuelType)}>
        {(["benzin", "motorin", "lpg"] as FuelType[]).map((f) => (
          <option key={f} value={f}>
            {FUEL_LABEL[f]}
          </option>
        ))}
      </select>

      <label htmlFor="var-measured">Ölçülen litre</label>
      <input
        id="var-measured"
        type="number"
        step="0.01"
        min="0"
        value={measured}
        onChange={(e) => setMeasured(e.target.value)}
        placeholder="ör. 8180"
        required
      />
      {tank && (
        <p className="hint-text">
          Kayıttaki stok: <strong>{formatLiters(tank.currentLiters)}</strong>
          {preview !== null && preview !== 0 && (
            <>
              {" · "}fark: <strong>{formatVariance(preview)}</strong>
            </>
          )}
        </p>
      )}

      {/* Sicaklik ve su AYRI iki kontroldur: sicaklik sapmadan genlesmeyi ayiklar
          (bkz. fuelVarianceService.thermalCorrection), su ise yakitin icinde ne
          oldugunu soyler ve kendi alarmini uretir. Ikisi de opsiyoneldir - girilmezse
          o kontrol o olcum icin yapilmaz, "sorun yok" sayilmaz. */}
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>
          <label htmlFor="var-temp">Sıcaklık (°C, opsiyonel)</label>
          <input id="var-temp" type="number" min={-40} max={70} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          <p className="hint-text">Girilirse genleşmenin açıkladığı litre sapmadan düşülür.</p>
        </div>
        <div>
          <label htmlFor="var-water">Tank dibi su (mm, opsiyonel)</label>
          <input id="var-water" type="number" min={0} max={1000} step={1} value={waterMm} onChange={(e) => setWaterMm(e.target.value)} />
          <p className="hint-text">Su bulucu macunla ölçülür. Eşik aşılırsa kritik alarm üretilir.</p>
        </div>
      </div>

      <label htmlFor="var-note">Not (opsiyonel)</label>
      <input
        id="var-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="ör. Vardiya sonu ölçümü"
        maxLength={300}
      />

      {error && <p className="error-text">{error}</p>}
      {result && (
        <p className={result.alarmRaised || result.waterAlarmRaised ? "error-text" : "hint-text"}>
          Ölçüm kaydedildi. Sapma: {formatVariance(result.variance)}.
          {result.alarmRaised
            ? " Eşik aşıldığı için kritik alarm oluşturuldu — Alarm Merkezi'nden takip edin."
            : " Eşiğin altında, alarm oluşturulmadı."}
          {result.waterAlarmRaised && " Ayrıca tank dibindeki su eşiği aşıldı: su alarmı oluşturuldu."}
        </p>
      )}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Kaydediliyor..." : "Ölçümü Kaydet"}
      </button>
    </form>
  );
}

/** Alarm esikleri. Iki kosul da saglanmadikca alarm cikmaz; bu, dusuk hacimli gunlerdeki yanlis alarmlari eler. */
function ThresholdCard({ settings, onSaved }: { settings: VarianceSettings | null; onSaved: () => void }) {
  const [thresholdPct, setThresholdPct] = useState("");
  const [minLiters, setMinLiters] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setThresholdPct(String(settings.thresholdPct));
    setMinLiters(String(settings.minLiters));
  }, [settings]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/fuel-stock/readings/settings", {
        thresholdPct: Number(thresholdPct),
        minLiters: Number(minLiters),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayarlar kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Alarm Eşikleri</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Kritik alarm, <strong>her iki</strong> eşik de aşıldığında oluşur. Oran, tank kapasitesine değil önceki
        ölçümden bu yana tanktan geçen hacme (satış + teslimat) göre hesaplanır.
      </p>

      <label htmlFor="var-pct">Sapma oranı eşiği (%)</label>
      <input
        id="var-pct"
        type="number"
        step="0.05"
        min="0"
        max="100"
        value={thresholdPct}
        onChange={(e) => setThresholdPct(e.target.value)}
        required
      />
      <p className="hint-text">Sektörde 0.5% civarı ölçüm/sıcaklık toleransı kabul edilir.</p>

      <label htmlFor="var-min">En düşük sapma (litre)</label>
      <input
        id="var-min"
        type="number"
        step="1"
        min="0"
        value={minLiters}
        onChange={(e) => setMinLiters(e.target.value)}
        required
      />
      <p className="hint-text">
        Bu litrenin altındaki farklar alarma dönüşmez. Az satış olan günlerde birkaç litrelik ölçüm hatası yüzde
        olarak büyük görünür; bu taban o yanlış alarmları eler.
      </p>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="hint-text">Eşikler güncellendi.</p>}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Kaydediliyor..." : "Eşikleri Kaydet"}
      </button>
    </form>
  );
}
