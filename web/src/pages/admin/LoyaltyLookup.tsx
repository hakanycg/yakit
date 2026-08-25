import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatDateTime } from "../../shared/format";

interface LoyaltyAccount {
  plate: string;
  points: number;
}

interface LoyaltyMovement {
  id: number;
  plate: string;
  type: "earn" | "redeem" | "refund" | "adjustment";
  points: number;
  balanceAfter: number;
  transactionId: number | null;
  note: string | null;
  username: string | null;
  createdAt: string;
}

const MOVEMENT_TYPE_LABEL: Record<string, string> = { earn: "Kazanım", redeem: "Kullanım", refund: "İade", adjustment: "Manuel Düzeltme" };
const MOVEMENT_TYPE_BADGE: Record<string, string> = { earn: "resolved", redeem: "warning", refund: "info", adjustment: "acknowledged" };

export default function LoyaltyLookup() {
  const stationId = useEffectiveStationId();
  const [plateInput, setPlateInput] = useState("");
  const [searchedPlate, setSearchedPlate] = useState<string | null>(null);
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [movements, setMovements] = useState<LoyaltyMovement[]>([]);
  const [recentMovements, setRecentMovements] = useState<LoyaltyMovement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newPoints, setNewPoints] = useState("");
  const [note, setNote] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function loadRecent() {
    if (stationId === null) return;
    api.get<{ movements: LoyaltyMovement[] }>("/api/loyalty/movements?limit=25").then((res) => setRecentMovements(res.movements));
  }
  useEffect(loadRecent, [stationId]);

  async function search(plate: string) {
    const trimmed = plate.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setSavedMsg(null);
    setAdjustError(null);
    try {
      const encoded = encodeURIComponent(trimmed);
      const [accountRes, movementsRes] = await Promise.all([
        api.get<{ account: LoyaltyAccount }>(`/api/loyalty/accounts/${encoded}`),
        api.get<{ movements: LoyaltyMovement[] }>(`/api/loyalty/movements?plate=${encoded}&limit=50`),
      ]);
      setAccount(accountRes.account);
      setMovements(movementsRes.movements);
      setSearchedPlate(accountRes.account.plate);
      setNewPoints(String(accountRes.account.points));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sorgu başarısız.");
      setAccount(null);
      setMovements([]);
      setSearchedPlate(null);
    } finally {
      setLoading(false);
    }
  }

  async function adjust() {
    if (!searchedPlate) return;
    const value = Number(newPoints);
    setAdjustError(null);
    setSavedMsg(null);
    if (Number.isNaN(value) || value < 0) {
      setAdjustError("Geçerli bir puan miktarı giriniz.");
      return;
    }
    if (!note.trim() || note.trim().length < 3) {
      setAdjustError("Açıklama zorunludur (en az 3 karakter).");
      return;
    }
    setSaving(true);
    try {
      const encoded = encodeURIComponent(searchedPlate);
      const res = await api.post<{ account: LoyaltyAccount }>(`/api/loyalty/accounts/${encoded}/adjust`, { newPoints: value, note: note.trim() });
      setAccount(res.account);
      setSavedMsg("Puan bakiyesi güncellendi.");
      setNote("");
      await search(searchedPlate);
      loadRecent();
    } catch (err) {
      setAdjustError(err instanceof ApiError ? err.message : "Düzeltme yapılamadı.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2>Sadakat Puanları</h2>
      <p className="hint-text settings-intro">
        Plaka bazında müşteri puan bakiyesini sorgulayın, hareket geçmişini görüntüleyin ve gerekirse manuel olarak
        düzeltin (ör. iade, hatalı kayıt, kampanya jesti).
      </p>

      <div className="card" style={{ marginTop: "1.1rem" }}>
        <h3>Plaka Sorgula</h3>
        <div className="toolbar">
          <input
            value={plateInput}
            onChange={(e) => setPlateInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search(plateInput)}
            placeholder="örn: 06 ABC 123"
            style={{ maxWidth: 220 }}
          />
          <button className="primary" disabled={loading || !plateInput.trim()} onClick={() => search(plateInput)}>
            {loading ? "Aranıyor..." : "Sorgula"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}

        {account && (
          <>
            <div className="card-divider">
              <div className="toolbar" style={{ alignItems: "baseline" }}>
                <span className="hint-text">Plaka: {account.plate}</span>
                <div className="spacer" />
                <div className="stat" style={{ alignItems: "flex-end" }}>
                  <span className="label">Güncel Bakiye</span>
                  <span className="value">{account.points} puan</span>
                </div>
              </div>

              <div className="field-grid" style={{ marginTop: "0.75rem" }}>
                <div>
                  <label>Yeni Puan Bakiyesi</label>
                  <input type="number" min={0} value={newPoints} onChange={(e) => setNewPoints(e.target.value)} />
                </div>
                <div>
                  <label>Açıklama (zorunlu)</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="örn: Müşteri şikayeti sonrası iade" />
                </div>
              </div>
              {adjustError && <p className="error-text">{adjustError}</p>}
              {savedMsg && <p className="success-text">{savedMsg}</p>}
              <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                <div className="spacer" />
                <button className="primary" disabled={saving} onClick={adjust}>
                  {saving ? "Kaydediliyor..." : "Bakiyeyi Düzelt"}
                </button>
              </div>
            </div>

            <div className="card-divider">
              <h4 style={{ margin: "0 0 0.5rem" }}>Hareket Geçmişi</h4>
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th><th>Tip</th><th className="numeric">Puan</th><th className="numeric">Bakiye</th><th>Açıklama</th><th>Kullanıcı</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td>{formatDateTime(m.createdAt)}</td>
                      <td><span className={`badge ${MOVEMENT_TYPE_BADGE[m.type] ?? ""}`}>{MOVEMENT_TYPE_LABEL[m.type] ?? m.type}</span></td>
                      <td className="numeric" style={{ color: m.points < 0 ? "var(--danger)" : "var(--accent-2)" }}>
                        {m.points > 0 ? "+" : ""}{m.points}
                      </td>
                      <td className="numeric">{m.balanceAfter}</td>
                      <td className="hint-text">{[m.note, m.transactionId ? `İşlem #${m.transactionId}` : null].filter(Boolean).join(" · ") || "-"}</td>
                      <td>{m.username ?? "-"}</td>
                    </tr>
                  ))}
                  {movements.length === 0 && <tr><td colSpan={6} className="hint-text">Bu plaka için hareket yok.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Son Hareketler (Tüm Plakalar)</h3>
        <table>
          <thead>
            <tr>
              <th>Tarih</th><th>Plaka</th><th>Tip</th><th className="numeric">Puan</th><th className="numeric">Bakiye</th><th>Açıklama</th><th>Kullanıcı</th>
            </tr>
          </thead>
          <tbody>
            {recentMovements.map((m) => (
              <tr key={m.id}>
                <td>{formatDateTime(m.createdAt)}</td>
                <td>{m.plate}</td>
                <td><span className="movement-type-pill delivery">{MOVEMENT_TYPE_LABEL[m.type] ?? m.type}</span></td>
                <td className="numeric" style={{ color: m.points < 0 ? "var(--danger)" : "var(--accent-2)" }}>
                  {m.points > 0 ? "+" : ""}{m.points}
                </td>
                <td className="numeric">{m.balanceAfter}</td>
                <td className="hint-text">{[m.note, m.transactionId ? `İşlem #${m.transactionId}` : null].filter(Boolean).join(" · ") || "-"}</td>
                <td>{m.username ?? "-"}</td>
              </tr>
            ))}
            {recentMovements.length === 0 && <tr><td colSpan={7} className="hint-text">Kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
