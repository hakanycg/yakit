import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useTopicSubscription } from "../../shared/useWebSocket";
import { useEscapeKey } from "../../shared/useEscapeKey";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useAuth } from "../../shared/AuthContext";
import { appendStationParam } from "../../shared/stationScope";
import { TRANSACTION_STATUS_LABEL, FUEL_LABEL, formatCurrency, formatDateTime, formatLiters } from "../../shared/format";
import Pagination from "../../shared/Pagination";
import type { Transaction } from "../../shared/types";

/** Iade yalnizca yoneticide: para disari cikaran tek ekran burasi (bkz. refundService.ts). */
const REFUND_ROLES = ["super_admin", "tenant_admin", "admin"];
const PAGE_SIZE = 25;

export default function Transactions() {
  const { user } = useAuth();
  const stationId = useEffectiveStationId();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [plateFilter, setPlateFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<Transaction | null>(null);
  const canRefund = user !== null && REFUND_ROLES.includes(user.role);

  // Filtre degistiginde sayfa 1'e donulur - AYNI olay isleyicisinde, aksi halde
  // eski sayfa+yeni filtreyle bir kere, sayfa 1+yeni filtreyle bir kere olmak
  // uzere CIFT sorgu atilirdi (bkz. Alarms.tsx/Stations.tsx'teki ayni desen).
  function updateFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (plateFilter.trim()) params.set("plate", plateFilter.trim());
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return params;
  }

  function load() {
    if (stationId === null) return;
    setLoading(true);
    const params = buildParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    api.get<{ transactions: Transaction[]; total: number }>(`/api/transactions?${params.toString()}`).then((res) => {
      setTransactions(res.transactions);
      setTotal(res.total);
      setLoading(false);
    });
  }

  useEffect(load, [statusFilter, plateFilter, dateFrom, dateTo, page, stationId]);

  useTopicSubscription(stationId !== null ? `transactions:${stationId}` : null, () => load());

  const csvHref = appendStationParam(`/api/transactions/export.csv?${buildParams().toString()}`);

  return (
    <div>
      <h2>İşlem Listesi</h2>
      <div className="toolbar">
        <select
          value={statusFilter}
          onChange={(e) => updateFilter(setStatusFilter, e.target.value)}
          style={{ width: 220 }}
        >
          <option value="">Tüm durumlar</option>
          {Object.entries(TRANSACTION_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input
          value={plateFilter}
          onChange={(e) => updateFilter(setPlateFilter, e.target.value)}
          placeholder="Plaka ile ara..."
          aria-label="Plaka ara"
          style={{ maxWidth: 160 }}
        />
        <label htmlFor="tx-date-from" style={{ margin: 0 }}>
          Başlangıç
        </label>
        <input
          id="tx-date-from"
          type="date"
          value={dateFrom}
          onChange={(e) => updateFilter(setDateFrom, e.target.value)}
          style={{ maxWidth: 150 }}
        />
        <label htmlFor="tx-date-to" style={{ margin: 0 }}>
          Bitiş
        </label>
        <input
          id="tx-date-to"
          type="date"
          value={dateTo}
          onChange={(e) => updateFilter(setDateTo, e.target.value)}
          style={{ maxWidth: 150 }}
        />
        <div className="spacer" />
        <a href={csvHref}>
          <button>CSV Dışa Aktar</button>
        </a>
      </div>

      <div className="card">
        {loading ? (
          <p className="hint-text">Yükleniyor...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th><th>Pompa</th><th>Plaka</th><th>Yakıt</th><th>Litre</th><th className="numeric">Tutar</th><th className="numeric">İndirim</th><th className="numeric">Puan</th><th>Durum</th><th>Oluşturulma</th><th>E-Fatura</th>{canRefund && <th>İade</th>}
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.pumpId}</td>
                  <td>{t.plate}</td>
                  <td>{FUEL_LABEL[t.fuelType]}</td>
                  <td>{formatLiters(t.dispensedLiters)}</td>
                  <td className="numeric">
                    {formatCurrency(t.chargeAmount)}
                    {t.discountAmount > 0 && (
                      <div className="hint-text" style={{ marginTop: 0 }}>yakıt değeri: {formatCurrency(t.totalAmount)}</div>
                    )}
                  </td>
                  <td className="numeric">
                    {t.discountAmount > 0 ? (
                      <>
                        -{formatCurrency(t.discountAmount)}
                        {t.discountCode && <div className="hint-text" style={{ marginTop: 0 }}>{t.discountCode}</div>}
                      </>
                    ) : "-"}
                  </td>
                  <td className="numeric">
                    {t.loyaltyPointsRedeemed > 0 && <div style={{ color: "var(--warning)" }}>-{t.loyaltyPointsRedeemed}</div>}
                    {t.loyaltyPointsEarned > 0 && <div style={{ color: "var(--accent-2)" }}>+{t.loyaltyPointsEarned}</div>}
                    {t.loyaltyPointsRedeemed <= 0 && t.loyaltyPointsEarned <= 0 && "-"}
                  </td>
                  <td><span className={`badge ${t.status}`}>{TRANSACTION_STATUS_LABEL[t.status]}</span></td>
                  <td>{formatDateTime(t.createdAt)}</td>
                  <td>{t.status === "completed" && <InvoiceCell transactionId={t.id} />}</td>
                  {canRefund && (
                    <td>
                      {t.status === "completed" && (
                        <RefundCell transaction={t} onOpen={() => setRefunding(t)} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={canRefund ? 12 : 11} className="hint-text">Kayıt bulunamadı.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <Pagination page={page} pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)} onChange={setPage} />

      {refunding && (
        <RefundDialog
          transaction={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            setRefunding(null);
            load();
          }}
        />
      )}
    </div>
  );
}

interface InvoiceInfo {
  status: "pending" | "sent" | "failed";
  providerInvoiceId: string | null;
  errorMessage: string | null;
}

function InvoiceCell({ transactionId }: { transactionId: number }) {
  const [invoice, setInvoice] = useState<InvoiceInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ invoice: InvoiceInfo | null }>(`/api/transactions/${transactionId}/invoice`).then((res) => setInvoice(res.invoice));
  }
  useEffect(load, [transactionId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ invoice: InvoiceInfo }>(`/api/transactions/${transactionId}/invoice`);
      setInvoice(res.invoice);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Fatura oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  if (invoice === undefined) return <span className="hint-text">...</span>;

  if (invoice?.status === "sent") {
    return <span className="badge completed" title={invoice.providerInvoiceId ?? undefined}>Kesildi</span>;
  }

  /**
   * Fatura artik satis biter bitmez kendiliginden kesiliyor (bkz.
   * server/src/services/invoiceAutoService.ts). Buradaki dugme bu yuzden bir
   * "olustur" eylemi degil, otomatik kesim saglayici tarafinda basarisiz
   * oldugunda kullanilan YENIDEN DENEME yolu. Metin de bunu soylemeli - aksi
   * halde personel her satista buna basmasi gerektigini saniyor.
   */
  const failed = invoice?.status === "failed";
  return (
    <div>
      <button onClick={create} disabled={busy}>
        {busy ? "..." : failed ? "Yeniden Dene" : "Şimdi Kes"}
      </button>
      {!failed && !error && (
        <div className="hint-text" style={{ fontSize: "var(--fs-2xs)", maxWidth: 220 }}>
          Satış bitince otomatik kesilir.
        </div>
      )}
      {error && <div className="error-text" style={{ fontSize: "var(--fs-2xs)", maxWidth: 220 }}>{error}</div>}
      {!error && failed && (
        <div className="error-text" style={{ fontSize: "var(--fs-2xs)", maxWidth: 220 }}>{invoice.errorMessage}</div>
      )}
    </div>
  );
}

interface RefundRecord {
  id: number;
  amount: number;
  reason: string;
  paymentMethod: string;
  status: "completed" | "failed";
  errorMessage: string | null;
  username: string | null;
  createdAt: string;
}

interface RefundableInfo {
  chargedAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  refundable: boolean;
  reason: string | null;
}

interface RefundState {
  refunds: RefundRecord[];
  info: RefundableInfo;
}

/** Listede yalnizca ozet; ayrinti ve iade formu acilir pencerede. */
function RefundCell({ transaction, onOpen }: { transaction: Transaction; onOpen: () => void }) {
  const refunded = transaction.refundedAmount ?? 0;
  // Iade bir ariza degil: kirmizi rozet operatore "bir sey bozuldu" derdi. Rozet
  // dikkat cekmek icin sari; tam mi kismi mi oldugunu etiketin kendisi soyluyor.
  const partial = refunded > 0 && refunded < transaction.chargeAmount;
  return (
    <div>
      {refunded > 0 && (
        <div className="badge warning" title={`İade edilen: ${formatCurrency(refunded)}`}>
          {partial ? "Kısmi iade" : "İade edildi"}
        </div>
      )}
      <button className="ghost btn-sm" onClick={onOpen} style={{ marginTop: refunded > 0 ? "0.35rem" : 0 }}>
        {refunded > 0 ? "Detay" : "İade"}
      </button>
    </div>
  );
}

function RefundDialog({
  transaction,
  onClose,
  onDone,
}: {
  transaction: Transaction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [state, setState] = useState<RefundState | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onClose);

  function load() {
    api
      .get<RefundState>(`/api/transactions/${transaction.id}/refunds`)
      .then((res) => {
        setState(res);
        // Varsayilan olarak kalanin tamami: en sik durum "islemi tumuyle geri al".
        setAmount(res.info.refundableAmount > 0 ? String(res.info.refundableAmount) : "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "İade bilgisi alınamadı."));
  }
  useEffect(load, [transaction.id]);

  async function submit() {
    if (!state) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Geçerli bir iade tutarı girin.");
      return;
    }
    if (
      !confirm(
        `${formatCurrency(value)} tutarında iade yapılacak. Para müşteriye geri gönderilir ve bu işlem geri alınamaz. Onaylıyor musunuz?`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/transactions/${transaction.id}/refunds`, { amount: value, reason: reason.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İade yapılamadı.");
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="station-card-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>İade — İşlem #{transaction.id}</h3>
            <p className="hint-text" style={{ marginTop: 0 }}>
              {transaction.plate} · {FUEL_LABEL[transaction.fuelType]} · {formatDateTime(transaction.createdAt)}
            </p>
          </div>
          <button className="ghost btn-sm" onClick={onClose} aria-label="Kapat">✕</button>
        </div>

        {error && <p className="error-text">{error}</p>}
        {!state ? (
          <p className="hint-text">Yükleniyor...</p>
        ) : (
          <>
            <dl className="detail-list">
              <dt>Tahsil edilen</dt>
              <dd>{formatCurrency(state.info.chargedAmount)}</dd>
              <dt>İade edilen</dt>
              <dd>{formatCurrency(state.info.refundedAmount)}</dd>
              <dt>İade edilebilir</dt>
              <dd>{formatCurrency(state.info.refundableAmount)}</dd>
            </dl>

            {state.info.refundable ? (
              <>
                <label>
                  İade tutarı (TL)
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={state.info.refundableAmount}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label>
                  Gerekçe
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Örn. yakıt akmadı, müşteri talebi"
                    maxLength={300}
                  />
                </label>
                <p className="hint-text">
                  Kısmi iade yapılabilir. Kazanılan sadakat puanı iade oranında geri alınır. İade, işlemin gününe
                  değil kesildiği günün kasasına yazılır.
                </p>
                <div className="modal-actions">
                  <button onClick={() => void submit()} disabled={busy || reason.trim().length < 3}>
                    {busy ? "İade yapılıyor..." : "İadeyi Yap"}
                  </button>
                  <button className="ghost" onClick={onClose}>Vazgeç</button>
                </div>
              </>
            ) : (
              <p className="hint-text">{state.info.reason}</p>
            )}

            {state.refunds.length > 0 && (
              <section className="station-section">
                <div className="station-section-head">
                  <h4 className="station-section-title">İade Geçmişi</h4>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="numeric">Tutar</th><th>Gerekçe</th><th>Durum</th><th>Kullanıcı</th><th>Tarih</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.refunds.map((r) => (
                        <tr key={r.id}>
                          <td className="numeric">{formatCurrency(r.amount)}</td>
                          <td>{r.reason}</td>
                          <td>
                            <span className={`badge ${r.status === "completed" ? "resolved" : "fault"}`}>
                              {r.status === "completed" ? "Tamamlandı" : "Başarısız"}
                            </span>
                            {r.errorMessage && <div className="error-text" style={{ fontSize: "0.75rem" }}>{r.errorMessage}</div>}
                          </td>
                          <td>{r.username ?? "-"}</td>
                          <td>{formatDateTime(r.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
