import { useEffect, useState } from "react";
import { api, ApiError } from "../../../shared/api";
import { useEffectiveStationId } from "../../../shared/useEffectiveStation";
import type { FuelPrice } from "../../../shared/types";
import StatusToggle from "./StatusToggle";

interface LoyaltyConfig {
  enabled: boolean;
  pointsPerLiter: number;
  pointValueTry: number;
  tierSilverThreshold: number;
  tierGoldThreshold: number;
  pointExpiryEnabled: boolean;
  pointExpiryMonths: number;
}

export default function LoyaltySettings() {
  const stationId = useEffectiveStationId();
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [pointsPerLiter, setPointsPerLiter] = useState("");
  const [pointValueTry, setPointValueTry] = useState("");
  const [tierSilverThreshold, setTierSilverThreshold] = useState("");
  const [tierGoldThreshold, setTierGoldThreshold] = useState("");
  const [pointExpiryMonths, setPointExpiryMonths] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Geri odeme oranini GERCEK litre fiyatiyla goster - genel bir varsayim degil,
  // admin'in kendi istasyonundaki fiyat uzerinden hesaplanir.
  const [avgFuelPrice, setAvgFuelPrice] = useState<number | null>(null);

  function load() {
    if (stationId === null) return;
    api.get<{ config: LoyaltyConfig }>("/api/loyalty/config").then((res) => {
      setConfig(res.config);
      setPointsPerLiter(String(res.config.pointsPerLiter));
      setPointValueTry(String(res.config.pointValueTry));
      setTierSilverThreshold(String(res.config.tierSilverThreshold));
      setTierGoldThreshold(String(res.config.tierGoldThreshold));
      setPointExpiryMonths(String(res.config.pointExpiryMonths));
    });
    api.get<{ fuelPrices: FuelPrice[] }>("/api/settings/fuel-prices").then((res) => {
      if (res.fuelPrices.length === 0) return;
      setAvgFuelPrice(res.fuelPrices.reduce((sum, p) => sum + p.pricePerLiter, 0) / res.fuelPrices.length);
    });
  }
  useEffect(load, [stationId]);

  const parsedPointsPerLiter = Number(pointsPerLiter);
  const parsedPointValueTry = Number(pointValueTry);
  const validNumbers =
    Number.isFinite(parsedPointsPerLiter) && parsedPointsPerLiter >= 0 && Number.isFinite(parsedPointValueTry) && parsedPointValueTry >= 0;
  // Litre basina kazanilan TL indirim degeri - iki alanin BIRLIKTE ne anlama geldigini
  // gosteren tek sayi. Ayri ayri makul gorunen iki deger (ör. "50" ve "100") birlikte
  // yikici olabilir (bkz. asagidaki uyari esigi) - admin bunu ayri ayri goremez.
  const valuePerLiter = validNumbers ? parsedPointsPerLiter * parsedPointValueTry : null;
  const cashbackPct = valuePerLiter !== null && avgFuelPrice ? (valuePerLiter / avgFuelPrice) * 100 : null;
  // %10 ustu, akaryakit sektorunde hicbir sadakat programinin gercekci olarak
  // sunamayacagi bir oran - yanlislikla girilmis bir ondalik/birim hatasinin isaretidir.
  const HIGH_CASHBACK_WARNING_PCT = 10;

  const parsedSilverThreshold = Number(tierSilverThreshold);
  const parsedGoldThreshold = Number(tierGoldThreshold);
  const validTierThresholds =
    Number.isFinite(parsedSilverThreshold) &&
    parsedSilverThreshold >= 0 &&
    Number.isFinite(parsedGoldThreshold) &&
    parsedGoldThreshold > parsedSilverThreshold;

  const parsedPointExpiryMonths = Number(pointExpiryMonths);
  const validPointExpiryMonths = Number.isInteger(parsedPointExpiryMonths) && parsedPointExpiryMonths >= 1 && parsedPointExpiryMonths <= 120;

  async function update(patch: Partial<LoyaltyConfig>) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await api.patch("/api/loyalty/config", patch);
      setSavedMsg("Sadakat ayarları güncellendi.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ayar güncellenemedi.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return null;

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="card-head">
          <h3>Sadakat / Puan Sistemi</h3>
          <StatusToggle checked={config.enabled} disabled={saving} onChange={() => update({ enabled: !config.enabled })} />
        </div>
        <p className="hint-text card-desc">
          Aktif olduğunda müşteriler her dolumda plaka bazında puan kazanır; kiosk'ta bir sonraki dolumda bu puanları
          indirim olarak kullanabilirler.
        </p>

        <div className="field-grid">
          <div>
            <label>Litre başına kazanılan puan</label>
            <input type="number" min={0} step={0.1} value={pointsPerLiter} onChange={(e) => setPointsPerLiter(e.target.value)} />
            <p className="hint-text" style={{ marginTop: "0.25rem" }}>
              Müşterinin her litre alımında kazandığı puan sayısı. Örn: <strong>50</strong> yazarsanız, 10 litre alan
              müşteri 500 puan kazanır.
            </p>
          </div>
          <div>
            <label>1 puanın TL değeri (kullanıldığında)</label>
            <input type="number" min={0} step={0.01} value={pointValueTry} onChange={(e) => setPointValueTry(e.target.value)} />
            <p className="hint-text" style={{ marginTop: "0.25rem" }}>
              Kazanılan puanların TL karşılığı. Bu genellikle <strong>1'in çok altında küçük bir sayı</strong> olmalı
              (varsayılan: <strong>0.10</strong> — yani 1 puan = 10 kuruş). Yukarıdaki "litre başına puan" zaten büyük
              bir sayıysa (ör. 50), bu alana da büyük bir sayı (ör. 100) yazmak iki değeri birbirine çarpar ve
              işletmeyi zarara sokacak kadar yüksek bir indirim üretir.
            </p>
          </div>
        </div>

        {validNumbers && valuePerLiter !== null && valuePerLiter > 0 && (
          <p className={`hint-text ${cashbackPct !== null && cashbackPct > HIGH_CASHBACK_WARNING_PCT ? "error-text" : ""}`}>
            Bu ayarla: her litre alımda müşteri <strong>{valuePerLiter.toFixed(2)} TL</strong> değerinde puan
            kazanıyor
            {cashbackPct !== null && (
              <>
                {" "}
                (istasyonunuzun ortalama litre fiyatına göre yaklaşık <strong>%{cashbackPct.toFixed(1)}</strong> geri
                ödeme oranı)
              </>
            )}
            .
            {cashbackPct !== null && cashbackPct > HIGH_CASHBACK_WARNING_PCT && (
              <>
                {" "}
                Bu oran akaryakıt sektörü için olağan dışı yüksek (çoğu program %1-%5 arası çalışır) — muhtemelen
                "1 puanın TL değeri" alanına yanlışlıkla büyük bir sayı girildi, kontrol edin.
              </>
            )}
          </p>
        )}

        <h4 style={{ marginTop: "1.5rem" }}>Kademe Sistemi (Bronz / Gümüş / Altın)</h4>
        <p className="hint-text card-desc">
          Kademe, mevcut puan bakiyesine değil müşterinin YAŞAM BOYU kazandığı toplam puana göre belirlenir - böylece
          puanını kullanan sadık bir müşteri kademe kaybetmez. Yeni müşteriler Bronz ile başlar.
        </p>
        <div className="field-grid">
          <div>
            <label>Gümüş kademe eşiği (yaşam boyu puan)</label>
            <input type="number" min={0} step={1} value={tierSilverThreshold} onChange={(e) => setTierSilverThreshold(e.target.value)} />
          </div>
          <div>
            <label>Altın kademe eşiği (yaşam boyu puan)</label>
            <input type="number" min={0} step={1} value={tierGoldThreshold} onChange={(e) => setTierGoldThreshold(e.target.value)} />
          </div>
        </div>
        {!validTierThresholds && <p className="error-text">Altın eşiği, gümüş eşiğinden büyük olmalıdır.</p>}

        <div className="card-head" style={{ marginTop: "1.5rem" }}>
          <h4>Puan Geçerlilik Süresi</h4>
          <StatusToggle
            checked={config.pointExpiryEnabled}
            disabled={saving}
            onChange={() => update({ pointExpiryEnabled: !config.pointExpiryEnabled })}
          />
        </div>
        <p className="hint-text card-desc">
          Aktif olduğunda, belirtilen süre boyunca hiç hareket görmeyen hesapların puan BAKİYESİ sıfırlanır (yaşam
          boyu kazanılan puan ve kademe etkilenmez). Bir dolum/kullanım hareketi süreyi sıfırdan başlatır.
        </p>
        <div className="field-grid">
          <div>
            <label>Geçerlilik süresi (ay)</label>
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={pointExpiryMonths}
              onChange={(e) => setPointExpiryMonths(e.target.value)}
            />
          </div>
        </div>
        {!validPointExpiryMonths && <p className="error-text">Süre 1 ile 120 ay arasında bir tam sayı olmalıdır.</p>}

        {error && <p className="error-text">{error}</p>}
        {savedMsg && <p className="success-text">{savedMsg}</p>}

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <div className="spacer" />
          <button
            className="primary"
            disabled={saving || !validNumbers || !validTierThresholds || !validPointExpiryMonths}
            onClick={() =>
              update({
                pointsPerLiter: Number(pointsPerLiter),
                pointValueTry: Number(pointValueTry),
                tierSilverThreshold: Number(tierSilverThreshold),
                tierGoldThreshold: Number(tierGoldThreshold),
                pointExpiryMonths: Number(pointExpiryMonths),
              })
            }
          >
            Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}
