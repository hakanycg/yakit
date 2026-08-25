import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../shared/api";
import { appendStationParam } from "../../shared/stationScope";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import {
  FUEL_LABEL,
  PAYMENT_METHOD_LABEL,
  TRANSACTION_STATUS_LABEL,
  formatCurrency,
  formatDateTime,
  formatLiters,
} from "../../shared/format";
import { AlertIcon, CheckCircleIcon, WalletIcon } from "../../shared/icons";
import type { DaySummary, ReconciliationRecord } from "../../shared/types";

/**
 * Gun sonu kasa/odeme mutabakati: sistemin kaydina gore tahsil edilmis olmasi gereken
 * tutar ile hesaba GERCEKTEN gecen tutarin karsilastirilmasi.
 */

/** Turkiye UTC+3; is gunu yerel gece yarisinda baslar (bkz. reconciliationService.ts). */
function todayBusinessDate(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function Reconciliation() {
  const stationId = useEffectiveStationId();
  const [date, setDate] = useState(todayBusinessDate);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [history, setHistory] = useState<ReconciliationRecord[]>([]);

  function load() {
    if (stationId === null) return;
    api.get<{ summary: DaySummary }>(`/api/reconciliation/summary?date=${date}`).then((res) => setSummary(res.summary));
    api.get<{ reconciliations: ReconciliationRecord[] }>("/api/reconciliation").then((res) => setHistory(res.reconciliations));
  }

  useEffect(load, [stationId, date]);

  const csvHref = appendStationParam("/api/reconciliation/export.csv");

  return (
    <div>
      <h2>Gün Sonu Mutabakatı</h2>
      <p className="hint-text">
        Sistemin kaydına göre tahsil edilmiş olması gereken tutarı, banka/POS ekstrenize gerçekten geçen tutarla
        karşılaştırır. İş günü Türkiye saatiyle gece yarısında başlar.
      </p>

      <div className="toolbar">
        <label htmlFor="rec-date" style={{ margin: 0 }}>
          İş günü
        </label>
        <input id="rec-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 190 }} />
        <div className="spacer" />
        <a href={csvHref}>
          <button type="button">CSV İndir</button>
        </a>
      </div>

      {summary && <DayCards summary={summary} />}

      <div className="grid cols-2">
        {summary && <BreakdownCard summary={summary} />}
        {summary && <CloseDayCard summary={summary} onClosed={load} />}
      </div>

      {summary && summary.pending.length > 0 && <PendingCard summary={summary} />}

      <h3>Kapatılmış Günler</h3>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>İş günü</th>
              <th>Beklenen</th>
              <th>Gerçekleşen</th>
              <th>Fark</th>
              <th>Askıda</th>
              <th>Kapatan</th>
              <th>Not</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.businessDate}</strong>
                  <div className="hint-text">{formatDateTime(r.closedAt)}</div>
                </td>
                <td>{formatCurrency(r.expectedTotal)}</td>
                <td>{formatCurrency(r.declaredTotal)}</td>
                <td>
                  <span className={`badge ${r.difference === 0 ? "resolved" : "critical"}`}>
                    {r.difference > 0 ? "+" : ""}
                    {formatCurrency(r.difference)}
                  </span>
                </td>
                <td>{r.pendingCount > 0 ? <span className="badge warning">{r.pendingCount}</span> : "—"}</td>
                <td>{r.closedBy ?? "—"}</td>
                <td>{r.note ?? "—"}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="hint-text">
                  Henüz kapatılmış gün yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayCards({ summary }: { summary: DaySummary }) {
  const closed = summary.closed;
  return (
    <div className="grid stats-grid">
      <div className="card stat dash-stat">
        <div className="stat-icon" style={{ background: "rgba(58,160,255,0.15)", color: "var(--accent)" }}>
          <WalletIcon />
        </div>
        <div className="stat-body">
          <span className="label">Beklenen tahsilat</span>
          <span className="value">{formatCurrency(summary.expectedTotal)}</span>
          <span className="stat-caption">
            {summary.transactionCount} işlem · {formatCurrency(summary.discountAmount)} indirim/puan
            {summary.refundedCount > 0 && ` · ${formatCurrency(summary.refundedAmount)} iade dahil`}
          </span>
        </div>
      </div>

      <div className="card stat dash-stat">
        <div
          className="stat-icon"
          style={
            closed && closed.difference !== 0
              ? { background: "rgba(248,113,113,0.15)", color: "#f87171" }
              : { background: "rgba(34,197,94,0.15)", color: "#4ade80" }
          }
        >
          {closed && closed.difference !== 0 ? <AlertIcon /> : <CheckCircleIcon />}
        </div>
        <div className="stat-body">
          <span className="label">Fark</span>
          <span
            className="value"
            style={closed && closed.difference !== 0 ? { color: "#f87171" } : undefined}
          >
            {closed ? `${closed.difference > 0 ? "+" : ""}${formatCurrency(closed.difference)}` : "—"}
          </span>
          <span className="stat-caption">{closed ? "Gün kapatıldı" : "Gün henüz kapatılmadı"}</span>
        </div>
      </div>

      <div className="card stat dash-stat">
        <div
          className="stat-icon"
          style={
            summary.pending.length > 0
              ? { background: "rgba(248,113,113,0.15)", color: "#f87171" }
              : { background: "rgba(34,197,94,0.15)", color: "#4ade80" }
          }
        >
          {summary.pending.length > 0 ? <AlertIcon /> : <CheckCircleIcon />}
        </div>
        <div className="stat-body">
          <span className="label">Askıda işlem</span>
          <span className="value" style={summary.pending.length > 0 ? { color: "#f87171" } : undefined}>
            {summary.pending.length}
          </span>
          <span className="stat-caption">Para bloke / tahsilat sorunlu</span>
        </div>
      </div>
    </div>
  );
}

function BreakdownCard({ summary }: { summary: DaySummary }) {
  return (
    <div className="card">
      <h3>Gün Kırılımı</h3>

      <h4 className="station-section-title">Ödeme Yöntemi</h4>
      <table>
        <tbody>
          {summary.byPaymentMethod.map((p) => (
            <tr key={p.paymentMethod}>
              <td>{PAYMENT_METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</td>
              <td className="hint-text">{p.count} işlem</td>
              <td style={{ textAlign: "right" }}>
                <strong>{formatCurrency(p.amount)}</strong>
              </td>
            </tr>
          ))}
          {summary.byPaymentMethod.length === 0 && (
            <tr>
              <td className="hint-text">Bu iş gününde tamamlanmış işlem yok.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h4 className="station-section-title">Yakıt Tipi</h4>
      <table>
        <tbody>
          {summary.byFuelType.map((f) => (
            <tr key={f.fuelType}>
              <td>{FUEL_LABEL[f.fuelType] ?? f.fuelType}</td>
              <td className="hint-text">{formatLiters(f.liters)}</td>
              <td style={{ textAlign: "right" }}>
                <strong>{formatCurrency(f.amount)}</strong>
              </td>
            </tr>
          ))}
          {summary.byFuelType.length === 0 && (
            <tr>
              <td className="hint-text">—</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Gerceklesen tutar ELLE girilir: iyzico'nun hakedis raporunu cekecek bir ucu yok
 * (bkz. iyzicoService.ts) ve zaten mutabakatin anlami, sistemin disindaki bir kaynagi
 * sisteme karsi dogrulamaktir - sayiyi sistemin kendisi uretirse mutabakat olmaz.
 */
function CloseDayCard({ summary, onClosed }: { summary: DaySummary; onClosed: () => void }) {
  const [declared, setDeclared] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDeclared("");
    setNote("");
    setError(null);
  }, [summary.businessDate]);

  const declaredNum = Number(declared);
  const preview =
    declared !== "" && Number.isFinite(declaredNum)
      ? Math.round((declaredNum - summary.expectedTotal) * 100) / 100
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/reconciliation/close", {
        businessDate: summary.businessDate,
        declaredTotal: declaredNum,
        note: note.trim() || undefined,
      });
      onClosed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gün kapatılamadı.");
    } finally {
      setSaving(false);
    }
  }

  if (summary.closed) {
    const c = summary.closed;
    return (
      <div className="card">
        <h3>Gün Kapatıldı</h3>
        <dl className="detail-list">
          <dt>Beklenen</dt>
          <dd>{formatCurrency(c.expectedTotal)}</dd>
          <dt>Gerçekleşen</dt>
          <dd>{formatCurrency(c.declaredTotal)}</dd>
          <dt>Fark</dt>
          <dd>
            <span className={`badge ${c.difference === 0 ? "resolved" : "critical"}`}>
              {c.difference > 0 ? "+" : ""}
              {formatCurrency(c.difference)}
            </span>
          </dd>
          <dt>Kapatan</dt>
          <dd>
            {c.closedBy ?? "—"} · {formatDateTime(c.closedAt)}
          </dd>
          {c.note && (
            <>
              <dt>Not</dt>
              <dd>{c.note}</dd>
            </>
          )}
        </dl>
        <p className="hint-text">
          Kapatılan günün rakamları o anki haliyle saklanır; sonradan gelen iade veya düzeltmeler bu kaydı geriye
          dönük değiştirmez.
        </p>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Günü Kapat</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Banka/POS ekstrenizde bu iş gününe karşılık gelen tutarı girin. Sistem farkı hesaplar ve kalıcı olarak
        kaydeder.
      </p>

      <label htmlFor="rec-declared">Gerçekleşen tutar (₺)</label>
      <input
        id="rec-declared"
        type="number"
        step="0.01"
        min="0"
        value={declared}
        onChange={(e) => setDeclared(e.target.value)}
        placeholder={String(summary.expectedTotal)}
        required
      />
      <p className="hint-text">
        Beklenen: <strong>{formatCurrency(summary.expectedTotal)}</strong>
        {preview !== null && preview !== 0 && (
          <>
            {" · "}fark: <strong>{preview > 0 ? "+" : ""}{formatCurrency(preview)}</strong>
          </>
        )}
      </p>

      <label htmlFor="rec-note">Not (opsiyonel)</label>
      <input
        id="rec-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="ör. POS komisyonu düşülmüş"
        maxLength={500}
      />

      {summary.refundedCount > 0 && (
        <p className="hint-text">
          Beklenen tutara, gün içinde iade edilmiş {formatCurrency(summary.refundedAmount)} dahildir: kart o gün
          gerçekten çekilmiştir. İade hesabınıza aynı gün yansıdıysa ekstreniz bu kadar düşük görünür.
        </p>
      )}

      {summary.pending.length > 0 && (
        <p className="hint-text">
          Bu günde {summary.pending.length} askıda işlem var. Kapatmadan önce aşağıdaki listeyi gözden geçirin —
          farkın kaynağı büyük ihtimalle orada.
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Kapatılıyor..." : "Günü Kapat"}
      </button>
    </form>
  );
}

/** Mutabakatsizligin gercek kaynagi genelde bu listedir. */
function PendingCard({ summary }: { summary: DaySummary }) {
  return (
    <div className="card">
      <h3>Askıda Kalan İşlemler</h3>
      <p className="hint-text" style={{ marginTop: 0 }}>
        Parası bloke edilmiş ama işi bitmemiş, ya da tahsilatı başarısız/iade olmuş işlemler. Ekstre ile kayıt
        arasındaki farkın kaynağı genelde buradadır.
      </p>
      <table>
        <thead>
          <tr>
            <th>İşlem</th>
            <th>Plaka</th>
            <th>Durum</th>
            <th>Ödeme</th>
            <th>Tutar</th>
            <th>Saat</th>
          </tr>
        </thead>
        <tbody>
          {summary.pending.map((p) => (
            <tr key={p.id}>
              <td>#{p.id}</td>
              <td>
                <code>{p.plate}</code>
              </td>
              <td>{TRANSACTION_STATUS_LABEL[p.status] ?? p.status}</td>
              <td>
                {PAYMENT_METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}
                <div className="hint-text">{p.paymentStatus}</div>
              </td>
              <td>{formatCurrency(p.amount)}</td>
              <td>{formatDateTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
