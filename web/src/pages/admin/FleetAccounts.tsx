import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency, formatDateTime } from "../../shared/format";

interface FleetPlate {
  id: number;
  plate: string;
  createdAt: string;
}

interface FleetAccount {
  id: number;
  companyName: string;
  vkn: string | null;
  billingType: "prepaid" | "postpaid";
  balance: number;
  creditLimit: number | null;
  availableAmount: number | null;
  active: boolean;
  createdAt: string;
  plates: FleetPlate[];
}

interface FleetMovement {
  id: number;
  type: "topup" | "charge" | "refund" | "adjustment";
  amount: number;
  balanceAfter: number;
  transactionId: number | null;
  note: string | null;
  username: string | null;
  createdAt: string;
}

const MOVEMENT_LABEL: Record<FleetMovement["type"], string> = {
  topup: "Bakiye Yukleme / Odeme",
  charge: "Tahsilat",
  refund: "Iade",
  adjustment: "Duzeltme",
};

export default function FleetAccounts() {
  const stationId = useEffectiveStationId();
  const [accounts, setAccounts] = useState<FleetAccount[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (stationId === null) return;
    api.get<{ accounts: FleetAccount[] }>("/api/fleet-accounts").then((res) => setAccounts(res.accounts));
  }
  useEffect(load, [stationId]);

  async function toggleActive(a: FleetAccount) {
    setError(null);
    try {
      await api.patch(`/api/fleet-accounts/${a.id}/active`, { active: !a.active });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Guncellenemedi.");
    }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Filo Hesaplari</h2>
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni Filo Hesabi</button>
      </div>
      <p className="hint-text">
        Sirketlerin birden fazla plakasini tek bir bakiyeye (on odemeli) veya kredi limitine (sonradan faturalandirma)
        bagliyoruz. Kiosk'ta bu plakalardan biriyle islem yapan musteri, kart yerine dogrudan sirket hesabindan odeyebilir.
      </p>
      {error && <p className="error-text">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Sirket</th><th>VKN</th><th>Odeme Tipi</th><th className="numeric">Bakiye/Borc</th>
            <th className="numeric">Kullanilabilir</th><th>Plakalar</th><th>Durum</th><th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.companyName}</strong></td>
              <td>{a.vkn ?? "-"}</td>
              <td>{a.billingType === "prepaid" ? "On Odemeli" : "Sonradan Fatura"}</td>
              <td className="numeric">{formatCurrency(a.balance)}</td>
              <td className="numeric">{a.availableAmount !== null ? formatCurrency(a.availableAmount) : "Sinirsiz"}</td>
              <td>{a.plates.length}</td>
              <td><span className={`badge ${a.active ? "resolved" : "critical"}`}>{a.active ? "Aktif" : "Pasif"}</span></td>
              <td className="toolbar">
                <button onClick={() => setDetailId(a.id)}>Detay</button>
                <button onClick={() => toggleActive(a)}>{a.active ? "Pasife Al" : "Aktif Et"}</button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={8} className="hint-text">Henuz filo hesabi yok.</td></tr>}
        </tbody>
      </table>

      {showCreate && (
        <CreateAccountDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {detailId !== null && (
        <AccountDetailDialog accountId={detailId} account={accounts.find((a) => a.id === detailId) ?? null} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </div>
  );
}

function Modal({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}>
      <div className="card" style={{ width: wide ? "min(720px, 94vw)" : "min(480px, 92vw)", maxHeight: "90vh", overflowY: "auto" }}>{children}</div>
    </div>
  );
}

function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [vkn, setVkn] = useState("");
  const [billingType, setBillingType] = useState<"prepaid" | "postpaid">("prepaid");
  const [creditLimit, setCreditLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/fleet-accounts", {
        companyName: companyName.trim(),
        vkn: vkn.trim() || undefined,
        billingType,
        creditLimit: billingType === "postpaid" && creditLimit ? Number(creditLimit) : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Hesap olusturulamadi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal>
      <h3 style={{ marginTop: 0 }}>Yeni Filo Hesabi</h3>

      <label>Sirket Adi</label>
      <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoFocus />

      <label>VKN (opsiyonel)</label>
      <input value={vkn} onChange={(e) => setVkn(e.target.value)} />

      <label>Odeme Tipi</label>
      <select value={billingType} onChange={(e) => setBillingType(e.target.value as "prepaid" | "postpaid")}>
        <option value="prepaid">On Odemeli (bakiye yuklenir, harcandikca duser)</option>
        <option value="postpaid">Sonradan Fatura (borc birikir, aylik odenir)</option>
      </select>

      {billingType === "postpaid" && (
        <>
          <label>Kredi Limiti (opsiyonel, bos = sinirsiz)</label>
          <input type="number" min={0} step={0.01} value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1.25rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Vazgec</button>
        <div className="spacer" />
        <button className="primary" disabled={submitting || !companyName.trim()} onClick={submit}>
          {submitting ? "Olusturuluyor..." : "Olustur"}
        </button>
      </div>
    </Modal>
  );
}

function AccountDetailDialog({
  accountId,
  account,
  onClose,
  onChanged,
}: {
  accountId: number;
  account: FleetAccount | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [movements, setMovements] = useState<FleetMovement[]>([]);
  const [newPlate, setNewPlate] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpNote, setTopUpNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function loadMovements() {
    api.get<{ movements: FleetMovement[] }>(`/api/fleet-accounts/${accountId}/movements`).then((res) => setMovements(res.movements));
  }
  useEffect(loadMovements, [accountId]);

  async function addPlate() {
    if (!newPlate.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/fleet-accounts/${accountId}/plates`, { plate: newPlate.trim() });
      setNewPlate("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Plaka eklenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function removePlate(plateId: number) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/fleet-accounts/${accountId}/plates/${plateId}`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Plaka silinemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTopUp() {
    if (!topUpAmount || Number(topUpAmount) <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/fleet-accounts/${accountId}/topup`, { amount: Number(topUpAmount), note: topUpNote.trim() || undefined });
      setTopUpAmount("");
      setTopUpNote("");
      onChanged();
      loadMovements();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Islem yapilamadi.");
    } finally {
      setBusy(false);
    }
  }

  if (!account) return null;

  return (
    <Modal wide>
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>{account.companyName}</h3>
        <div className="spacer" />
        <button onClick={onClose}>Kapat</button>
      </div>
      <p className="hint-text">
        {account.billingType === "prepaid" ? "On odemeli" : "Sonradan fatura"} - Bakiye/Borc: {formatCurrency(account.balance)}
        {account.availableAmount !== null && ` - Kullanilabilir: ${formatCurrency(account.availableAmount)}`}
      </p>
      {error && <p className="error-text">{error}</p>}

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>
          <h4>Plakalar</h4>
          <div className="toolbar">
            <input value={newPlate} onChange={(e) => setNewPlate(e.target.value.toUpperCase())} placeholder="34 ABC 123" />
            <button onClick={addPlate} disabled={busy}>Ekle</button>
          </div>
          <ul style={{ listStyle: "none", padding: 0, marginTop: "0.75rem" }}>
            {account.plates.map((p) => (
              <li key={p.id} className="toolbar" style={{ padding: "0.35rem 0" }}>
                <span dir="ltr">{p.plate}</span>
                <div className="spacer" />
                <button onClick={() => removePlate(p.id)} disabled={busy}>Kaldir</button>
              </li>
            ))}
            {account.plates.length === 0 && <li className="hint-text">Henuz plaka eklenmedi.</li>}
          </ul>
        </div>

        <div>
          <h4>{account.billingType === "prepaid" ? "Bakiye Yukle" : "Odeme Kaydet (borc kapama)"}</h4>
          <label>Tutar (TL)</label>
          <input type="number" min={0} step={0.01} value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} />
          <label>Not (opsiyonel)</label>
          <input value={topUpNote} onChange={(e) => setTopUpNote(e.target.value)} />
          <button className="primary" style={{ marginTop: "0.75rem" }} onClick={submitTopUp} disabled={busy}>
            {account.billingType === "prepaid" ? "Bakiye Yukle" : "Odeme Kaydet"}
          </button>
        </div>
      </div>

      <h4 style={{ marginTop: "1.5rem" }}>Hareket Gecmisi</h4>
      <table>
        <thead>
          <tr><th>Tarih</th><th>Tip</th><th className="numeric">Tutar</th><th className="numeric">Sonraki Bakiye</th><th>Not</th><th>Kullanici</th></tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id}>
              <td>{formatDateTime(m.createdAt)}</td>
              <td>{MOVEMENT_LABEL[m.type]}</td>
              <td className="numeric">{formatCurrency(m.amount)}</td>
              <td className="numeric">{formatCurrency(m.balanceAfter)}</td>
              <td>{m.note ?? (m.transactionId ? `Islem #${m.transactionId}` : "-")}</td>
              <td>{m.username ?? "-"}</td>
            </tr>
          ))}
          {movements.length === 0 && <tr><td colSpan={6} className="hint-text">Henuz hareket yok.</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}
