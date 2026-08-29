import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";
import Pagination from "../../shared/Pagination";

const KIND_LABEL: Record<string, string> = { avans: "Avans", masraf: "Masraf" };
const PAGE_SIZE = 25;

interface StaffUser {
  id: number;
  displayName: string;
  active: boolean;
}

interface Balance {
  userId: number;
  displayName: string;
  openAvans: number;
  openMasraf: number;
}

interface Entry {
  id: number;
  userId: number;
  displayName: string;
  kind: string;
  amount: number;
  description: string | null;
  entryDate: string;
  settled: boolean;
  settledAt: string | null;
}

export default function StaffAdvances() {
  const stationId = useEffectiveStationId();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [userFilter, setUserFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [settledFilter, setSettledFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (userFilter) params.set("userId", userFilter);
    if (kindFilter) params.set("kind", kindFilter);
    if (settledFilter) params.set("settled", settledFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return params;
  }

  function loadUsers() {
    if (stationId === null) return;
    api.get<{ users: StaffUser[] }>("/api/users").then((res) => setUsers(res.users));
  }

  function loadBalances() {
    if (stationId === null) return;
    api.get<{ balances: Balance[] }>("/api/staff-advances/balances").then((res) => setBalances(res.balances));
  }

  function loadEntries() {
    if (stationId === null) return;
    const params = filterParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    api
      .get<{ entries: Entry[]; total: number }>(`/api/staff-advances?${params.toString()}`)
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Kayitlar yuklenemedi."));
  }

  useEffect(loadUsers, [stationId]);
  useEffect(loadBalances, [stationId]);
  useEffect(loadEntries, [stationId, userFilter, kindFilter, settledFilter, dateFrom, dateTo, page]);

  async function handleSettle(entry: Entry) {
    try {
      await api.patch(`/api/staff-advances/${entry.id}`, {});
      loadEntries();
      loadBalances();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kayit kapatilamadi.");
    }
  }

  async function handleDelete(entry: Entry) {
    if (!confirm(`${formatCurrency(entry.amount)} tutarindaki kaydi silmek istediginize emin misiniz?`)) return;
    try {
      await api.delete(`/api/staff-advances/${entry.id}`);
      loadEntries();
      loadBalances();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kayit silinemedi.");
    }
  }

  const csvHref = appendStationParam(`/api/staff-advances/export.csv?${filterParams().toString()}`);

  return (
    <div>
      <h2>Personel Avans/Masraf Takibi</h2>
      <p className="hint-text">
        Personele verilen (maaştan kesilecek) nakit avanslar ve personelin işletme için yaptığı, geri ödeme bekleyen
        masrafları izler.
      </p>

      {balances.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Açık Bakiyeler</h3>
          <table>
            <thead>
              <tr>
                <th>Personel</th>
                <th>Açık Avans</th>
                <th>Açık Masraf</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.userId}>
                  <td>{b.displayName}</td>
                  <td>{b.openAvans > 0 ? <span className="badge critical">{formatCurrency(b.openAvans)}</span> : "—"}</td>
                  <td>{b.openMasraf > 0 ? <span className="badge critical">{formatCurrency(b.openMasraf)}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Kayıtlar</h3>
          <div className="spacer" />
          <select value={userFilter} onChange={(e) => updateFilter(setUserFilter, e.target.value)} style={{ width: 180 }}>
            <option value="">Tüm personel</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
          <select value={kindFilter} onChange={(e) => updateFilter(setKindFilter, e.target.value)} style={{ width: 140 }}>
            <option value="">Avans/Masraf</option>
            <option value="avans">Avans</option>
            <option value="masraf">Masraf</option>
          </select>
          <select value={settledFilter} onChange={(e) => updateFilter(setSettledFilter, e.target.value)} style={{ width: 140 }}>
            <option value="">Tüm durumlar</option>
            <option value="false">Açık</option>
            <option value="true">Kapandı</option>
          </select>
          <label htmlFor="sa-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="sa-date-from" type="date" value={dateFrom} onChange={(e) => updateFilter(setDateFrom, e.target.value)} style={{ maxWidth: 150 }} />
          <label htmlFor="sa-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="sa-date-to" type="date" value={dateTo} onChange={(e) => updateFilter(setDateTo, e.target.value)} style={{ maxWidth: 150 }} />
          <a href={csvHref}>
            <button type="button">CSV İndir</button>
          </a>
          <button type="button" className="primary" onClick={() => setShowAdd(true)} disabled={users.length === 0}>
            Kayıt Ekle
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Personel</th>
              <th>Tür</th>
              <th>Açıklama</th>
              <th>Tutar</th>
              <th>Durum</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.entryDate}</td>
                <td>{e.displayName}</td>
                <td>
                  <span className={`badge ${e.kind === "avans" ? "resolved" : "critical"}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                </td>
                <td>{e.description || "-"}</td>
                <td>{formatCurrency(e.amount)}</td>
                <td>
                  <span className={`badge ${e.settled ? "resolved" : "critical"}`}>{e.settled ? "Kapandı" : "Açık"}</span>
                </td>
                <td>
                  {!e.settled && (
                    <button type="button" className="ghost btn-sm" onClick={() => handleSettle(e)}>
                      Kapat
                    </button>
                  )}
                  <button type="button" className="ghost btn-sm" onClick={() => handleDelete(e)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} className="hint-text">
                  Bu filtreye uyan kayıt yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <Pagination page={page} pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)} onChange={setPage} />
      </div>

      {showAdd && (
        <AddEntryDialog
          users={users}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            loadEntries();
            loadBalances();
          }}
        />
      )}
    </div>
  );
}

function AddEntryDialog({ users, onClose, onCreated }: { users: StaffUser[]; onClose: () => void; onCreated: () => void }) {
  const [userId, setUserId] = useState(users[0]?.id ?? 0);
  const [kind, setKind] = useState<"avans" | "masraf">("avans");
  const [amount, setAmount] = useState("");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/staff-advances", {
        userId,
        kind,
        amount: Number(amount),
        entryDate,
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kayit eklenemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Kayıt Ekle</h3>

        <label htmlFor="sa-add-user">Personel</label>
        <select id="sa-add-user" value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
              {u.active ? "" : " (pasif)"}
            </option>
          ))}
        </select>

        <label htmlFor="sa-add-kind">Tür</label>
        <select id="sa-add-kind" value={kind} onChange={(e) => setKind(e.target.value as "avans" | "masraf")}>
          <option value="avans">Avans</option>
          <option value="masraf">Masraf</option>
        </select>

        <label htmlFor="sa-add-amount">Tutar (TL)</label>
        <input id="sa-add-amount" type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />

        <label htmlFor="sa-add-date">Tarih</label>
        <input id="sa-add-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />

        <label htmlFor="sa-add-description">Açıklama (opsiyonel)</label>
        <input id="sa-add-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !userId || !amount || Number(amount) <= 0 || !entryDate}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
