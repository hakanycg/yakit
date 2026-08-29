import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { formatCurrency } from "../../shared/format";
import Pagination from "../../shared/Pagination";

const PAGE_SIZE = 25;

interface Supplier {
  id: number;
  name: string;
  active: boolean;
}

interface LedgerEntry {
  supplierId: number;
  supplierName: string;
  totalOwed: number;
  totalPaid: number;
  balance: number;
  uncostedDeliveries: number;
}

interface Payment {
  id: number;
  supplierId: number;
  amount: number;
  paymentDate: string;
  note: string | null;
  createdAt: string;
}

export default function SupplierLedger() {
  const stationId = useEffectiveStationId();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [supplierFilter, setSupplierFilter] = useState("");
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
    if (supplierFilter) params.set("supplierId", supplierFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return params;
  }

  function loadSuppliers() {
    if (stationId === null) return;
    api.get<{ suppliers: Supplier[] }>("/api/fuel-stock/suppliers").then((res) => setSuppliers(res.suppliers));
  }

  function loadLedger() {
    if (stationId === null) return;
    api.get<{ ledger: LedgerEntry[] }>("/api/supplier-ledger").then((res) => setLedger(res.ledger));
  }

  function loadPayments() {
    if (stationId === null) return;
    const params = filterParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    api
      .get<{ payments: Payment[]; total: number }>(`/api/supplier-ledger/payments?${params.toString()}`)
      .then((res) => {
        setPayments(res.payments);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Ödemeler yüklenemedi."));
  }

  useEffect(loadSuppliers, [stationId]);
  useEffect(loadLedger, [stationId]);
  useEffect(loadPayments, [stationId, supplierFilter, dateFrom, dateTo, page]);

  function supplierName(id: number): string {
    return suppliers.find((s) => s.id === id)?.name ?? `#${id}`;
  }

  async function handleDelete(payment: Payment) {
    if (!confirm(`${formatCurrency(payment.amount)} tutarındaki ödemeyi silmek istediğinize emin misiniz?`)) return;
    try {
      await api.delete(`/api/supplier-ledger/payments/${payment.id}`);
      loadPayments();
      loadLedger();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ödeme silinemedi.");
    }
  }

  const csvHref = appendStationParam(`/api/supplier-ledger/payments/export.csv?${filterParams().toString()}`);

  return (
    <div>
      <h2>Tedarikçi Cari Hesabı</h2>
      <p className="hint-text">
        Sipariş üzerinden yapılan teslimatlardan doğan tedarikçi borcu ve yapılan ödemeler. Serbest metinle (Stok Ekle) girilen
        manuel teslimatlar bu deftere dahil değildir.
      </p>

      {ledger.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Bakiye Özeti</h3>
          <table>
            <thead>
              <tr>
                <th>Tedarikçi</th>
                <th>Toplam Borç</th>
                <th>Toplam Ödenen</th>
                <th>Bakiye</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.supplierId}>
                  <td>
                    {l.supplierName}
                    {l.uncostedDeliveries > 0 && (
                      <span className="hint-text"> ({l.uncostedDeliveries} teslimat maliyetsiz, borca dahil değil)</span>
                    )}
                  </td>
                  <td>{formatCurrency(l.totalOwed)}</td>
                  <td>{formatCurrency(l.totalPaid)}</td>
                  <td>
                    <span className={`badge ${l.balance > 0 ? "warning" : l.balance < 0 ? "resolved" : ""}`}>
                      {formatCurrency(l.balance)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Ödemeler</h3>
          <div className="spacer" />
          <select value={supplierFilter} onChange={(e) => updateFilter(setSupplierFilter, e.target.value)} style={{ width: 200 }}>
            <option value="">Tüm tedarikçiler</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label htmlFor="sl-date-from" style={{ margin: 0 }}>
            Başlangıç
          </label>
          <input id="sl-date-from" type="date" value={dateFrom} onChange={(e) => updateFilter(setDateFrom, e.target.value)} style={{ maxWidth: 150 }} />
          <label htmlFor="sl-date-to" style={{ margin: 0 }}>
            Bitiş
          </label>
          <input id="sl-date-to" type="date" value={dateTo} onChange={(e) => updateFilter(setDateTo, e.target.value)} style={{ maxWidth: 150 }} />
          <a href={csvHref}>
            <button type="button">CSV İndir</button>
          </a>
          <button type="button" className="primary" onClick={() => setShowAdd(true)}>
            Ödeme Ekle
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Tedarikçi</th>
              <th>Not</th>
              <th>Tutar</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{p.paymentDate}</td>
                <td>{supplierName(p.supplierId)}</td>
                <td>{p.note || "-"}</td>
                <td>{formatCurrency(p.amount)}</td>
                <td>
                  <button type="button" className="ghost btn-sm" onClick={() => handleDelete(p)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={5} className="hint-text">
                  Bu filtreye uyan ödeme yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <Pagination page={page} pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)} onChange={setPage} />
      </div>

      {showAdd && (
        <AddPaymentDialog
          suppliers={suppliers}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            loadPayments();
            loadLedger();
          }}
        />
      )}
    </div>
  );
}

function AddPaymentDialog({
  suppliers,
  onClose,
  onCreated,
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? 0);
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/supplier-ledger/payments", {
        supplierId,
        amount: Number(amount),
        paymentDate,
        note: note.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ödeme kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Ödeme Ekle</h3>

        <label htmlFor="sl-add-supplier">Tedarikçi</label>
        <select id="sl-add-supplier" value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? "" : " (pasif)"}
            </option>
          ))}
        </select>

        <label htmlFor="sl-add-amount">Tutar (TL)</label>
        <input id="sl-add-amount" type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />

        <label htmlFor="sl-add-date">Tarih</label>
        <input id="sl-add-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />

        <label htmlFor="sl-add-note">Not (opsiyonel)</label>
        <input id="sl-add-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !supplierId || !amount || Number(amount) <= 0 || !paymentDate}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
