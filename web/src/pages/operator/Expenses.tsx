import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";
import Pagination from "../../shared/Pagination";

const CATEGORY_LABEL: Record<string, string> = {
  elektrik: "Elektrik",
  su_dogalgaz: "Su/Doğalgaz",
  kira: "Kira",
  bakim_onarim: "Bakım/Onarım",
  personel_maasi: "Personel Maaşı",
  sigorta: "Sigorta",
  vergi_harc: "Vergi/Harç",
  diger: "Diğer",
};
const CATEGORIES = Object.keys(CATEGORY_LABEL);
const PAGE_SIZE = 25;

interface Expense {
  id: number;
  category: string;
  description: string | null;
  amount: number;
  expenseDate: string;
  createdAt: string;
}

interface ExpenseSummary {
  byCategory: { category: string; total: number }[];
  total: number;
}

export default function Expenses() {
  const stationId = useEffectiveStationId();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtre degistiginde sayfa 1'e donulur - AYNI olay isleyicisinde, aksi halde
  // eski sayfa+yeni filtreyle bir kere, sayfa 1+yeni filtreyle bir kere olmak
  // uzere CIFT sorgu atilirdi (bkz. FuelStock.tsx/Alarms.tsx'teki ayni desen).
  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return params;
  }

  function loadExpenses() {
    if (stationId === null) return;
    const params = filterParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    api
      .get<{ expenses: Expense[]; total: number }>(`/api/expenses?${params.toString()}`)
      .then((res) => {
        setExpenses(res.expenses);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Giderler yüklenemedi."));
  }

  function loadSummary() {
    if (stationId === null) return;
    const params = filterParams();
    params.delete("category");
    api.get<ExpenseSummary>(`/api/expenses/summary?${params.toString()}`).then(setSummary);
  }

  useEffect(loadExpenses, [stationId, category, dateFrom, dateTo, page]);
  useEffect(loadSummary, [stationId, dateFrom, dateTo]);

  async function handleDelete(expense: Expense) {
    if (!confirm(`${formatCurrency(expense.amount)} tutarındaki gideri silmek istediğinize emin misiniz?`)) return;
    try {
      await api.delete(`/api/expenses/${expense.id}`);
      loadExpenses();
      loadSummary();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gider silinemedi.");
    }
  }

  const csvHref = appendStationParam(`/api/expenses/export.csv?${filterParams().toString()}`);

  return (
    <div>
      <h2>Genel Gider Takibi</h2>
      <p className="hint-text">Yakıt alım maliyeti dışındaki işletme giderleri (elektrik, kira, bakım, personel vb.).</p>

      {summary && summary.byCategory.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Kategori Özeti</h3>
          <table>
            <thead>
              <tr>
                <th>Kategori</th>
                <th>Toplam</th>
              </tr>
            </thead>
            <tbody>
              {summary.byCategory.map((c) => (
                <tr key={c.category}>
                  <td>{CATEGORY_LABEL[c.category] ?? c.category}</td>
                  <td>{formatCurrency(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontWeight: 600, marginBottom: 0 }}>Genel Toplam: {formatCurrency(summary.total)}</p>
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Giderler</h3>
          <div className="spacer" />
          <select value={category} onChange={(e) => updateFilter(setCategory, e.target.value)} style={{ width: 180 }}>
            <option value="">Tüm kategoriler</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <label htmlFor="exp-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="exp-date-from" type="date" value={dateFrom} onChange={(e) => updateFilter(setDateFrom, e.target.value)} style={{ maxWidth: 150 }} />
          <label htmlFor="exp-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="exp-date-to" type="date" value={dateTo} onChange={(e) => updateFilter(setDateTo, e.target.value)} style={{ maxWidth: 150 }} />
          <a href={csvHref}>
            <button type="button">CSV İndir</button>
          </a>
          <button type="button" className="primary" onClick={() => setShowAdd(true)}>
            Gider Ekle
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Kategori</th>
              <th>Açıklama</th>
              <th>Tutar</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id}>
                <td>{e.expenseDate}</td>
                <td>{CATEGORY_LABEL[e.category] ?? e.category}</td>
                <td>{e.description || "-"}</td>
                <td>{formatCurrency(e.amount)}</td>
                <td>
                  <button type="button" className="ghost btn-sm" onClick={() => handleDelete(e)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td colSpan={5} className="hint-text">
                  Bu filtreye uyan gider yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <Pagination page={page} pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)} onChange={setPage} />
      </div>

      {showAdd && (
        <AddExpenseDialog
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            loadExpenses();
            loadSummary();
          }}
        />
      )}
    </div>
  );
}

function AddExpenseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/expenses", {
        category,
        description: description.trim() || undefined,
        amount: Number(amount),
        expenseDate,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gider kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Gider Ekle</h3>

        <label htmlFor="exp-add-category">Kategori</label>
        <select id="exp-add-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>

        <label htmlFor="exp-add-amount">Tutar (TL)</label>
        <input id="exp-add-amount" type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />

        <label htmlFor="exp-add-date">Tarih</label>
        <input id="exp-add-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />

        <label htmlFor="exp-add-description">Açıklama (opsiyonel)</label>
        <input id="exp-add-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !amount || Number(amount) <= 0 || !expenseDate}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
