import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import StatusToggle from "./settings/StatusToggle";

interface RetentionSettings {
  enabled: boolean;
  retentionMonths: number;
}

interface RetentionPreview {
  cutoff: string;
  transactions: number;
  loyaltyMovements: number;
  dormantLoyaltyAccounts: number;
}

interface PersonalTransaction {
  id: number;
  fuelType: string;
  dispensedLiters: number;
  totalAmount: number;
  paymentMethod: string;
  status: string;
  receiptEmail: string | null;
  receiptPhone: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface PersonalLoyaltyMovement {
  id: number;
  type: string;
  points: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

interface PersonalDataReport {
  plate: string;
  transactions: PersonalTransaction[];
  loyalty: { points: number; movements: PersonalLoyaltyMovement[] } | null;
  fleetLinked: boolean;
}

interface ErasureResult {
  plate: string;
  transactionsAnonymized: number;
  loyaltyAccountDeleted: boolean;
  loyaltyMovementsAnonymized: number;
}

export default function KvkkRequests() {
  const [plateInput, setPlateInput] = useState("");
  const [report, setReport] = useState<PersonalDataReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [erasing, setErasing] = useState(false);
  const [eraseError, setEraseError] = useState<string | null>(null);
  const [eraseResult, setEraseResult] = useState<ErasureResult | null>(null);

  async function search() {
    const trimmed = plateInput.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setReport(null);
    setEraseResult(null);
    setEraseError(null);
    try {
      const encoded = encodeURIComponent(trimmed);
      const res = await api.get<{ report: PersonalDataReport }>(`/api/kvkk/lookup/${encoded}`);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sorgu başarısız.");
    } finally {
      setLoading(false);
    }
  }

  async function erase() {
    if (!report) return;
    setEraseError(null);
    if (!reason.trim() || reason.trim().length < 3) {
      setEraseError("Talep gerekçesi zorunludur (en az 3 karakter).");
      return;
    }
    if (confirmText.trim().toUpperCase() !== "SIL") {
      setEraseError('Onaylamak için kutuya büyük harflerle "SIL" yazınız.');
      return;
    }
    setErasing(true);
    try {
      const encoded = encodeURIComponent(report.plate);
      const res = await api.post<{ result: ErasureResult }>(`/api/kvkk/erase/${encoded}`, { reason: reason.trim() });
      setEraseResult(res.result);
      setReport(null);
      setReason("");
      setConfirmText("");
    } catch (err) {
      setEraseError(err instanceof ApiError ? err.message : "Silme işlemi başarısız.");
    } finally {
      setErasing(false);
    }
  }

  return (
    <div>
      <h2>KVKK Veri Sahibi Başvuruları</h2>
      <p className="hint-text settings-intro">
        6698 sayılı KVKK kapsamında bir plaka sahibinin "erişim hakkı" (kendisine ait hangi
        verinin tutulduğunu görme) veya "unutulma hakkı" (silinme/anonimleştirme) talebini
        buradan işleyebilirsiniz. İşlem ve ödeme kayıtları vergisel saklama yükümlülüğü
        nedeniyle tamamen silinmez; bunun yerine plaka/e-posta/telefon gibi kimlik bilgileri
        anonimleştirilir, tutar ve tarih kayıtları muhasebe amacıyla korunur.
      </p>

      <div className="card" style={{ marginTop: "1.1rem" }}>
        <h3>Plaka Sorgula</h3>
        <div className="toolbar">
          <input
            value={plateInput}
            onChange={(e) => setPlateInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="örn: 06 ABC 123"
            style={{ maxWidth: 220 }}
          />
          <button className="primary" disabled={loading || !plateInput.trim()} onClick={search}>
            {loading ? "Aranıyor..." : "Sorgula"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}

        {eraseResult && (
          <p className="success-text" style={{ marginTop: "0.75rem" }}>
            "{eraseResult.plate}" plakasına ait {eraseResult.transactionsAnonymized} işlem ve{" "}
            {eraseResult.loyaltyMovementsAnonymized} sadakat hareketi anonimleştirildi
            {eraseResult.loyaltyAccountDeleted ? "; sadakat puan hesabı silindi." : "."}
          </p>
        )}

        {report && (
          <>
            <div className="card-divider">
              <div className="toolbar" style={{ alignItems: "baseline" }}>
                <span className="hint-text">Plaka: {report.plate}</span>
                <div className="spacer" />
                {report.loyalty && (
                  <div className="stat" style={{ alignItems: "flex-end" }}>
                    <span className="label">Sadakat Bakiyesi</span>
                    <span className="value">{report.loyalty.points} puan</span>
                  </div>
                )}
              </div>
              {report.fleetLinked && (
                <p className="hint-text" style={{ color: "#f59e0b" }}>
                  Bu plaka bir filo hesabına bağlı. Silme işlemi için önce Filo Hesapları sayfasından hesaptan çıkarılması gerekir.
                </p>
              )}

              <h4 style={{ margin: "0.75rem 0 0.5rem" }}>İşlem Geçmişi ({report.transactions.length})</h4>
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th><th>Yakıt</th><th className="numeric">Litre</th><th className="numeric">Tutar</th>
                    <th>Ödeme</th><th>Durum</th><th>Makbuz E-posta</th><th>Makbuz Telefon</th>
                  </tr>
                </thead>
                <tbody>
                  {report.transactions.map((t) => (
                    <tr key={t.id}>
                      <td>{formatDateTime(t.startedAt)}</td>
                      <td>{t.fuelType}</td>
                      <td className="numeric">{formatLiters(t.dispensedLiters)}</td>
                      <td className="numeric">{formatCurrency(t.totalAmount)}</td>
                      <td>{t.paymentMethod}</td>
                      <td>{t.status}</td>
                      <td>{t.receiptEmail ?? "-"}</td>
                      <td>{t.receiptPhone ?? "-"}</td>
                    </tr>
                  ))}
                  {report.transactions.length === 0 && <tr><td colSpan={8} className="hint-text">İşlem kaydı yok.</td></tr>}
                </tbody>
              </table>

              {report.loyalty && (
                <>
                  <h4 style={{ margin: "0.75rem 0 0.5rem" }}>Sadakat Hareketleri ({report.loyalty.movements.length})</h4>
                  <table>
                    <thead>
                      <tr><th>Tarih</th><th>Tip</th><th className="numeric">Puan</th><th className="numeric">Bakiye</th><th>Açıklama</th></tr>
                    </thead>
                    <tbody>
                      {report.loyalty.movements.map((m) => (
                        <tr key={m.id}>
                          <td>{formatDateTime(m.createdAt)}</td>
                          <td>{m.type}</td>
                          <td className="numeric">{m.points > 0 ? "+" : ""}{m.points}</td>
                          <td className="numeric">{m.balanceAfter}</td>
                          <td className="hint-text">{m.note ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            {!report.fleetLinked && (
              <div className="card-divider">
                <h4 style={{ margin: "0 0 0.5rem", color: "var(--danger)" }}>Unutulma Hakkı: Verileri Anonimleştir</h4>
                <p className="hint-text">
                  Bu işlem geri alınamaz: yukarıdaki işlemlerin plaka/e-posta/telefon bilgileri "[SILINDI]" ile
                  değiştirilir, sadakat puan hesabı tamamen silinir. Tutar ve tarih kayıtları korunur.
                </p>
                <div className="field-grid">
                  <div>
                    <label>Talep Gerekçesi (zorunlu)</label>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="örn: Müşteri KVKK başvurusu, 21.08.2026" />
                  </div>
                  <div>
                    <label>Onaylamak için "SIL" yazın</label>
                    <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="SIL" />
                  </div>
                </div>
                {eraseError && <p className="error-text">{eraseError}</p>}
                <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                  <div className="spacer" />
                  <button className="danger" disabled={erasing} onClick={erase}>
                    {erasing ? "Siliniyor..." : "Verileri Kalıcı Olarak Anonimleştir"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <RetentionCard />
    </div>
  );
}

/**
 * Saklama suresi karti.
 *
 * Silme/erisim talebi ekrani yalnizca TALEP UZERINE calisir; KVKK ise kisisel verinin
 * gerekli sureden uzun tutulmamasini da ister - kimse talep etmese bile. Bu kart o
 * otomatik imhayi yonetir.
 */
function RetentionCard() {
  const stationId = useEffectiveStationId();
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [months, setMonths] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    if (stationId === null) return;
    api
      .get<{ settings: RetentionSettings; preview: RetentionPreview }>("/api/kvkk/retention")
      .then((res) => {
        setSettings(res.settings);
        setPreview(res.preview);
        setMonths(String(res.settings.retentionMonths));
      })
      .catch(() => setSettings(null));
  }
  useEffect(load, [stationId]);

  async function save(next: Partial<RetentionSettings>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.patch<{ settings: RetentionSettings; preview: RetentionPreview }>("/api/kvkk/retention", next);
      setSettings(res.settings);
      setPreview(res.preview);
      setMonths(String(res.settings.retentionMonths));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ result: { transactionsAnonymized: number; loyaltyMovementsAnonymized: number; dormantLoyaltyAccountsDeleted: number }; preview: RetentionPreview }>(
        "/api/kvkk/retention/run"
      );
      setPreview(res.preview);
      setMessage(
        `${res.result.transactionsAnonymized} işlem anonimleştirildi, ` +
          `${res.result.loyaltyMovementsAnonymized} sadakat hareketi temizlendi, ` +
          `${res.result.dormantLoyaltyAccountsDeleted} atıl sadakat hesabı silindi.`
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Çalıştırılamadı.");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3>Saklama Süresi (Otomatik İmha)</h3>
      <p className="hint-text prose">
        KVKK, kişisel verinin işlendiği amaç için gerekli olan süreden uzun tutulmamasını ister — kimse talep etmese
        bile. Süresi dolan işlemlerin <strong>plaka, makbuz e-postası ve telefonu</strong> otomatik olarak kaldırılır;
        <strong> tutar, litre ve tarih olduğu gibi kalır</strong>, çünkü mali kaydın saklanması (VUK/TTK) ayrı bir yasal
        zorunluluktur. Kısacası: <em>parayı tut, kimliği düşür.</em>
      </p>
      <p className="hint-text prose">
        Filo hesabına bağlı plakalara dokunulmaz — aktif bir ticari sözleşmeye bağlıdırlar, yani işleme amacı devam
        ediyordur.
      </p>

      <div className="settings-row">
        {/* Acik/kapali ayarlar panelin her yerinde ayni anahtar bilesenini kullanir
            (bkz. settings/StatusToggle.tsx); burada ham bir onay kutusu duruyordu. */}
        <StatusToggle
          checked={settings.enabled}
          disabled={busy}
          onChange={() => void save({ enabled: !settings.enabled })}
          activeLabel="Otomatik imha açık"
          inactiveLabel="Otomatik imha kapalı"
        />
        <div className="inline-field">
          <label htmlFor="ret-months">Saklama süresi (ay)</label>
          <div className="inline-field-controls">
            <input
              id="ret-months"
              type="number"
              min={6}
              max={240}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || months === String(settings.retentionMonths)}
              onClick={() => void save({ retentionMonths: Number(months) })}
            >
              Kaydet
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <p className={preview.transactions > 0 ? "error-text" : "hint-text"}>
          Şu anda süresi dolmuş: <strong>{preview.transactions}</strong> işlem,{" "}
          <strong>{preview.loyaltyMovements}</strong> sadakat hareketi,{" "}
          <strong>{preview.dormantLoyaltyAccounts}</strong> atıl sadakat hesabı. Sınır tarihi:{" "}
          {formatDateTime(preview.cutoff)}
        </p>
      )}

      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      <div className="card-footer-row">
        <span className="hint-text">Otomatik imha günde bir kez çalışır.</span>
        <button type="button" className="danger" disabled={busy || !settings.enabled} onClick={runNow}>
          Şimdi Uygula
        </button>
      </div>
    </div>
  );
}
