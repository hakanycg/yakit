import { useState } from "react";
import { api, ApiError } from "../../shared/api";
import { formatCurrency, formatDateTime, formatLiters } from "../../shared/format";

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
      setError(err instanceof ApiError ? err.message : "Sorgu basarisiz.");
    } finally {
      setLoading(false);
    }
  }

  async function erase() {
    if (!report) return;
    setEraseError(null);
    if (!reason.trim() || reason.trim().length < 3) {
      setEraseError("Talep gerekcesi zorunludur (en az 3 karakter).");
      return;
    }
    if (confirmText.trim().toUpperCase() !== "SIL") {
      setEraseError('Onaylamak icin kutuya buyuk harflerle "SIL" yaziniz.');
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
      setEraseError(err instanceof ApiError ? err.message : "Silme islemi basarisiz.");
    } finally {
      setErasing(false);
    }
  }

  return (
    <div>
      <h2>KVKK Veri Sahibi Basvurulari</h2>
      <p className="hint-text settings-intro">
        6698 sayili KVKK kapsaminda bir plaka sahibinin "erisim hakki" (kendisine ait hangi
        verinin tutuldugunu gorme) veya "unutulma hakki" (silinme/anonimlestirme) talebini
        buradan isleyebilirsiniz. Islem ve odeme kayitlari vergisel saklama yukumlulugu
        nedeniyle tamamen silinmez; bunun yerine plaka/e-posta/telefon gibi kimlik bilgileri
        anonimlestirilir, tutar ve tarih kayitlari muhasebe amaciyla korunur.
      </p>

      <div className="card" style={{ marginTop: "1.1rem" }}>
        <h3 style={{ marginTop: 0 }}>Plaka Sorgula</h3>
        <div className="toolbar">
          <input
            value={plateInput}
            onChange={(e) => setPlateInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="orn: 06 ABC 123"
            style={{ maxWidth: 220 }}
          />
          <button className="primary" disabled={loading || !plateInput.trim()} onClick={search}>
            {loading ? "Araniyor..." : "Sorgula"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}

        {eraseResult && (
          <p className="success-text" style={{ marginTop: "0.75rem" }}>
            "{eraseResult.plate}" plakasina ait {eraseResult.transactionsAnonymized} islem ve{" "}
            {eraseResult.loyaltyMovementsAnonymized} sadakat hareketi anonimlestirildi
            {eraseResult.loyaltyAccountDeleted ? "; sadakat puan hesabi silindi." : "."}
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
                  Bu plaka bir filo hesabina bagli. Silme islemi icin once Filo Hesaplari sayfasindan hesaptan cikarilmasi gerekir.
                </p>
              )}

              <h4 style={{ margin: "0.75rem 0 0.5rem" }}>Islem Gecmisi ({report.transactions.length})</h4>
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th><th>Yakit</th><th className="numeric">Litre</th><th className="numeric">Tutar</th>
                    <th>Odeme</th><th>Durum</th><th>Makbuz E-posta</th><th>Makbuz Telefon</th>
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
                  {report.transactions.length === 0 && <tr><td colSpan={8} className="hint-text">Islem kaydi yok.</td></tr>}
                </tbody>
              </table>

              {report.loyalty && (
                <>
                  <h4 style={{ margin: "0.75rem 0 0.5rem" }}>Sadakat Hareketleri ({report.loyalty.movements.length})</h4>
                  <table>
                    <thead>
                      <tr><th>Tarih</th><th>Tip</th><th className="numeric">Puan</th><th className="numeric">Bakiye</th><th>Aciklama</th></tr>
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
                <h4 style={{ margin: "0 0 0.5rem", color: "var(--danger)" }}>Unutulma Hakki: Verileri Anonimlestir</h4>
                <p className="hint-text">
                  Bu islem geri alinamaz: yukaridaki islemlerin plaka/e-posta/telefon bilgileri "[SILINDI]" ile
                  degistirilir, sadakat puan hesabi tamamen silinir. Tutar ve tarih kayitlari korunur.
                </p>
                <div className="field-grid">
                  <div>
                    <label>Talep Gerekcesi (zorunlu)</label>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="orn: Musteri KVKK basvurusu, 21.08.2026" />
                  </div>
                  <div>
                    <label>Onaylamak icin "SIL" yazin</label>
                    <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="SIL" />
                  </div>
                </div>
                {eraseError && <p className="error-text">{eraseError}</p>}
                <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                  <div className="spacer" />
                  <button className="danger" disabled={erasing} onClick={erase}>
                    {erasing ? "Siliniyor..." : "Verileri Kalici Olarak Anonimlestir"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
