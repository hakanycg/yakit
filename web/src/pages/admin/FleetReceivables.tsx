import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { useEffectiveStationId } from "../../shared/useEffectiveStation";
import { useEscapeKey } from "../../shared/useEscapeKey";
import { formatCurrency, formatDateTime } from "../../shared/format";

/**
 * Faturali filo hesaplarinin alacak yaslandirmasi.
 *
 * "Ne kadar borcu var" bilgisi Filo Hesaplari sayfasinda zaten vardi; burada cevaplanan
 * soru "NE KADAR SUREDIR odemedi". Ikisi ayri sayfada duruyor cunku ayri isler: biri
 * hesabi yonetmek, digeri tahsilat kovalamak.
 */

interface InvoiceReceivable {
  invoiceId: number;
  status: "pending" | "sent" | "failed";
  delivered: boolean;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueDate: string | null;
  payableAmount: number;
  paidAmount: number;
  remainingAmount: number;
  daysOverdue: number;
}

interface AgingBuckets {
  current: number;
  d1to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
}

interface AccountReceivable {
  accountId: number;
  companyName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTermDays: number | null;
  overdueBlockDays: number | null;
  invoices: InvoiceReceivable[];
  openAmount: number;
  overdueAmount: number;
  unbilledAmount: number;
  creditAmount: number;
  oldestOverdueDays: number;
  buckets: AgingBuckets;
}

const BUCKET_LABEL: Array<[keyof AgingBuckets, string]> = [
  ["current", "Vadesi gelmemiş"],
  ["d1to30", "1-30 gün"],
  ["d31to60", "31-60 gün"],
  ["d61to90", "61-90 gün"],
  ["d90plus", "90+ gün"],
];

export default function FleetReceivables() {
  const stationId = useEffectiveStationId();
  const [rows, setRows] = useState<AccountReceivable[]>([]);
  const [detail, setDetail] = useState<AccountReceivable | null>(null);

  useEffect(() => {
    if (stationId === null) return;
    api.get<{ accounts: AccountReceivable[] }>("/api/fleet-accounts/aging").then((r) => setRows(r.accounts));
  }, [stationId]);

  const totals = rows.reduce<AgingBuckets>(
    (acc, r) => ({
      current: acc.current + r.buckets.current,
      d1to30: acc.d1to30 + r.buckets.d1to30,
      d31to60: acc.d31to60 + r.buckets.d31to60,
      d61to90: acc.d61to90 + r.buckets.d61to90,
      d90plus: acc.d90plus + r.buckets.d90plus,
    }),
    { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0 }
  );
  const overdueTotal = totals.d1to30 + totals.d31to60 + totals.d61to90 + totals.d90plus;
  const missingTerm = rows.filter((r) => r.paymentTermDays === null && r.openAmount > 0);

  return (
    <div>
      <h2>Filo Alacakları</h2>
      <p className="hint-text">
        Faturalı (sonradan ödeme) hesapların yaşlandırma tablosu. Ön ödemeli hesaplar burada yoktur: orada bakiye
        bitince pompa zaten durur, tahsil edilememiş alacak oluşmaz.
      </p>

      <div className="grid stats-grid">
        {BUCKET_LABEL.map(([key, label]) => (
          <div className="card stat" key={key}>
            <span className="label">{label}</span>
            <span className="value" style={key === "d90plus" && totals[key] > 0 ? { color: "#f87171" } : undefined}>
              {formatCurrency(totals[key])}
            </span>
          </div>
        ))}
      </div>

      {overdueTotal > 0 && (
        <p className="hint-text">
          Vadesi geçen toplam <strong>{formatCurrency(overdueTotal)}</strong>.
        </p>
      )}

      {/* Vadesi girilmemis hesabin faturasi hicbir zaman gecikmis sayilmaz - bu sessiz
          bir bosluk olurdu, gorunur kilmak gerekiyor. */}
      {missingTerm.length > 0 && (
        <div className="card" style={{ borderColor: "#fbbf24" }}>
          <strong>Vade tanımlanmamış hesaplar:</strong>{" "}
          <span className="hint-text">
            {missingTerm.map((r) => r.companyName).join(", ")} — bu hesapların faturaları hiçbir zaman "vadesi geçti"
            sayılmaz. Filo Hesapları sayfasından vade gününü girin.
          </span>
        </div>
      )}

      <h3>Hesap Bazında</h3>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Şirket</th>
              <th>Vade</th>
              <th>Açık</th>
              <th>Vadesi geçen</th>
              <th>En eski gecikme</th>
              <th>Faturalanmamış</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId} onClick={() => setDetail(r)} style={{ cursor: "pointer" }}>
                <td>
                  <strong>{r.companyName}</strong>
                  {r.overdueBlockDays !== null && (
                    <div className="hint-text">{r.overdueBlockDays} gün gecikmede yakıt alımı durur</div>
                  )}
                </td>
                <td className="hint-text">{r.paymentTermDays === null ? "—" : `${r.paymentTermDays} gün`}</td>
                <td>{formatCurrency(r.openAmount)}</td>
                <td>
                  {r.overdueAmount > 0 ? (
                    <strong style={{ color: "#f87171" }}>{formatCurrency(r.overdueAmount)}</strong>
                  ) : (
                    <span className="hint-text">—</span>
                  )}
                </td>
                <td>
                  {r.oldestOverdueDays > 0 ? (
                    <span className={`badge ${r.oldestOverdueDays > 60 ? "critical" : "warning"}`}>
                      {r.oldestOverdueDays} gün
                    </span>
                  ) : (
                    <span className="hint-text">—</span>
                  )}
                </td>
                <td className="hint-text">{formatCurrency(r.unbilledAmount)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="hint-text">
                  Faturalı filo hesabı yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && <ReceivableDialog row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ReceivableDialog({ row, onClose }: { row: AccountReceivable; onClose: () => void }) {
  useEscapeKey(onClose);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="station-card-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="station-name">{row.companyName}</div>
            <div className="hint-text">
              {row.paymentTermDays === null ? "Vade tanımlı değil" : `${row.paymentTermDays} gün vade`}
              {row.creditAmount > 0 && ` · ${formatCurrency(row.creditAmount)} alacaklı bakiye`}
            </div>
          </div>
          <button className="ghost btn-sm" onClick={onClose} aria-label="Kapat">✕</button>
        </div>

        <table>
          <thead>
            <tr>
              <th>Fatura</th>
              <th>Kesim</th>
              <th>Vade</th>
              <th>Tutar</th>
              <th>Ödenen</th>
              <th>Kalan</th>
              <th>Gecikme</th>
            </tr>
          </thead>
          <tbody>
            {row.invoices.map((i) => (
              <tr key={i.invoiceId}>
                <td>
                  #{i.invoiceId}
                  {!i.delivered && <div className="hint-text">iletilmedi</div>}
                </td>
                <td className="hint-text">{formatDateTime(i.issuedAt)}</td>
                <td className="hint-text">{i.dueDate ? formatDateTime(i.dueDate) : "—"}</td>
                <td>{formatCurrency(i.payableAmount)}</td>
                <td className="hint-text">{formatCurrency(i.paidAmount)}</td>
                <td>
                  {i.remainingAmount > 0 ? <strong>{formatCurrency(i.remainingAmount)}</strong> : <span className="hint-text">kapandı</span>}
                </td>
                <td>
                  {i.daysOverdue > 0 ? (
                    <span className={`badge ${i.daysOverdue > 60 ? "critical" : "warning"}`}>{i.daysOverdue} gün</span>
                  ) : (
                    <span className="hint-text">—</span>
                  )}
                </td>
              </tr>
            ))}
            {row.invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="hint-text">
                  Bu hesaba henüz dönem faturası kesilmemiş.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {row.unbilledAmount !== 0 && (
          <p className="hint-text">
            Ayrıca <strong>{formatCurrency(row.unbilledAmount)}</strong> tutarında henüz faturalanmamış hareket var;
            bunun vadesi bir sonraki dönem faturasıyla başlar.
          </p>
        )}
      </div>
    </div>
  );
}
