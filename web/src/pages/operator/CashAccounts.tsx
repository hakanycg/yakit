import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";
import Pagination from "../../shared/Pagination";

const KIND_LABEL: Record<string, string> = { bank: "Banka", cash: "Nakit" };
const KINDS = Object.keys(KIND_LABEL);
const DIRECTION_LABEL: Record<string, string> = { in: "Giriş", out: "Çıkış" };
const PAGE_SIZE = 25;

interface Account {
  id: number;
  name: string;
  kind: string;
  active: boolean;
  balance: number;
}

interface Movement {
  id: number;
  accountId: number;
  direction: string;
  amount: number;
  movementDate: string;
  description: string | null;
  createdAt: string;
}

export default function CashAccounts() {
  const stationId = useEffectiveStationId();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [accountFilter, setAccountFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddMovement, setShowAddMovement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (accountFilter) params.set("accountId", accountFilter);
    if (directionFilter) params.set("direction", directionFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return params;
  }

  function loadAccounts() {
    if (stationId === null) return;
    api.get<{ accounts: Account[] }>("/api/cash-accounts").then((res) => setAccounts(res.accounts));
  }

  function loadMovements() {
    if (stationId === null) return;
    const params = filterParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    api
      .get<{ movements: Movement[]; total: number }>(`/api/cash-accounts/movements?${params.toString()}`)
      .then((res) => {
        setMovements(res.movements);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Hareketler yüklenemedi."));
  }

  useEffect(loadAccounts, [stationId]);
  useEffect(loadMovements, [stationId, accountFilter, directionFilter, dateFrom, dateTo, page]);

  function accountName(id: number): string {
    return accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  }

  async function handleDelete(movement: Movement) {
    if (!confirm(`${formatCurrency(movement.amount)} tutarındaki hareketi silmek istediğinize emin misiniz?`)) return;
    try {
      await api.delete(`/api/cash-accounts/movements/${movement.id}`);
      loadMovements();
      loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Hareket silinemedi.");
    }
  }

  const csvHref = appendStationParam(`/api/cash-accounts/movements/export.csv?${filterParams().toString()}`);

  return (
    <div>
      <h2>Kasa/Banka Hesabı</h2>
      <p className="hint-text">
        İşletmenin kendi banka/nakit hesaplarının elle tutulan hareket defteri. Gün Sonu Mutabakatı'ndaki günlük satış eşleşmesinden
        bağımsızdır.
      </p>

      {accounts.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
            <h3 style={{ margin: 0 }}>Hesaplar</h3>
            <div className="spacer" />
            <button type="button" className="primary" onClick={() => setShowAddAccount(true)}>
              Hesap Ekle
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Tür</th>
                <th>Bakiye</th>
                <th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{KIND_LABEL[a.kind] ?? a.kind}</td>
                  <td>
                    <span className={`badge ${a.balance < 0 ? "critical" : "resolved"}`}>{formatCurrency(a.balance)}</span>
                  </td>
                  <td>
                    <span className={`badge ${a.active ? "resolved" : "critical"}`}>{a.active ? "Aktif" : "Pasif"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {accounts.length === 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <p>Henüz bir hesap tanımlanmamış.</p>
          <button type="button" className="primary" onClick={() => setShowAddAccount(true)}>
            Hesap Ekle
          </button>
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Hareketler</h3>
          <div className="spacer" />
          <select value={accountFilter} onChange={(e) => updateFilter(setAccountFilter, e.target.value)} style={{ width: 180 }}>
            <option value="">Tüm hesaplar</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select value={directionFilter} onChange={(e) => updateFilter(setDirectionFilter, e.target.value)} style={{ width: 140 }}>
            <option value="">Giriş/Çıkış</option>
            <option value="in">Giriş</option>
            <option value="out">Çıkış</option>
          </select>
          <label htmlFor="ca-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="ca-date-from" type="date" value={dateFrom} onChange={(e) => updateFilter(setDateFrom, e.target.value)} style={{ maxWidth: 150 }} />
          <label htmlFor="ca-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="ca-date-to" type="date" value={dateTo} onChange={(e) => updateFilter(setDateTo, e.target.value)} style={{ maxWidth: 150 }} />
          <a href={csvHref}>
            <button type="button">CSV İndir</button>
          </a>
          <button type="button" className="primary" onClick={() => setShowAddMovement(true)} disabled={accounts.length === 0}>
            Hareket Ekle
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Hesap</th>
              <th>Yön</th>
              <th>Açıklama</th>
              <th>Tutar</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{m.movementDate}</td>
                <td>{accountName(m.accountId)}</td>
                <td>
                  <span className={`badge ${m.direction === "in" ? "resolved" : "critical"}`}>{DIRECTION_LABEL[m.direction] ?? m.direction}</span>
                </td>
                <td>{m.description || "-"}</td>
                <td>{formatCurrency(m.amount)}</td>
                <td>
                  <button type="button" className="ghost btn-sm" onClick={() => handleDelete(m)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td colSpan={6} className="hint-text">
                  Bu filtreye uyan hareket yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <Pagination page={page} pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)} onChange={setPage} />
      </div>

      {showAddAccount && (
        <AddAccountDialog
          onClose={() => setShowAddAccount(false)}
          onCreated={() => {
            setShowAddAccount(false);
            loadAccounts();
          }}
        />
      )}

      {showAddMovement && (
        <AddMovementDialog
          accounts={accounts}
          onClose={() => setShowAddMovement(false)}
          onCreated={() => {
            setShowAddMovement(false);
            loadMovements();
            loadAccounts();
          }}
        />
      )}
    </div>
  );
}

function AddAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(KINDS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/cash-accounts", { name: name.trim(), kind });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Hesap kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Hesap Ekle</h3>

        <label htmlFor="ca-add-name">Hesap Adı</label>
        <input id="ca-add-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />

        <label htmlFor="ca-add-kind">Tür</label>
        <select id="ca-add-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || name.trim().length < 2}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMovementDialog({ accounts, onClose, onCreated }: { accounts: Account[]; onClose: () => void; onCreated: () => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? 0);
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [movementDate, setMovementDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/cash-accounts/movements", {
        accountId,
        direction,
        amount: Number(amount),
        movementDate,
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Hareket kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Hareket Ekle</h3>

        <label htmlFor="ca-mv-account">Hesap</label>
        <select id="ca-mv-account" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.active ? "" : " (pasif)"}
            </option>
          ))}
        </select>

        <label htmlFor="ca-mv-direction">Yön</label>
        <select id="ca-mv-direction" value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
          <option value="in">Giriş</option>
          <option value="out">Çıkış</option>
        </select>

        <label htmlFor="ca-mv-amount">Tutar (TL)</label>
        <input id="ca-mv-amount" type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />

        <label htmlFor="ca-mv-date">Tarih</label>
        <input id="ca-mv-date" type="date" value={movementDate} onChange={(e) => setMovementDate(e.target.value)} />

        <label htmlFor="ca-mv-description">Açıklama (opsiyonel)</label>
        <input id="ca-mv-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !accountId || !amount || Number(amount) <= 0 || !movementDate}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
