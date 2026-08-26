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
  contactEmail: string | null;
  contactPhone: string | null;
  lowBalanceThreshold: number | null;
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

interface PortalUser {
  id: number;
  email: string;
  displayName: string | null;
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface FleetInvoiceLine {
  plate: string;
  fuelType: string;
  liters: number;
  amount: number;
  taxExclusiveAmount: number;
  taxAmount: number;
}

interface FleetInvoice {
  id: number;
  status: "pending" | "sent" | "failed";
  providerInvoiceId: string | null;
  errorMessage: string | null;
  periodStart: string;
  periodEnd: string;
  totalLiters: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  payableAmount: number;
  lines: FleetInvoiceLine[];
  createdAt: string;
}

interface FleetInvoiceDraft {
  movementCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  lines: FleetInvoiceLine[];
  totalLiters: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  payableAmount: number;
}

const MOVEMENT_LABEL: Record<FleetMovement["type"], string> = {
  topup: "Bakiye Yükleme / Ödeme",
  charge: "Tahsilat",
  refund: "İade",
  adjustment: "Düzeltme",
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
      setError(err instanceof ApiError ? err.message : "Güncellenemedi.");
    }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Filo Hesapları</h2>
        <div className="spacer" />
        <button className="primary" onClick={() => setShowCreate(true)}>Yeni Filo Hesabı</button>
      </div>
      <p className="hint-text">
        Şirketlerin birden fazla plakasını tek bir bakiyeye (ön ödemeli) veya kredi limitine (sonradan faturalandırma)
        bağlıyoruz. Kiosk'ta bu plakalardan biriyle işlem yapan müşteri, kart yerine doğrudan şirket hesabından ödeyebilir.
      </p>
      {error && <p className="error-text">{error}</p>}

      {/* Sekiz sutunlu tablo telefonda yatay kaydirma gerektiriyor ve eylem dugmeleri
          ekranin disinda kaliyordu. Istasyonlar/Destek Talepleri ile ayni desen: liste
          tek satir, detayin tamami satira tiklaninca acilan pencerede. */}
      <div className="station-list">
        {accounts.map((a) => (
          <div className="fleet-row" key={a.id}>
            <button type="button" className="station-row fleet-row-main" onClick={() => setDetailId(a.id)}>
              <span className="station-row-main">
                <span className="station-row-name">{a.companyName}</span>
                <span className="station-row-sub">
                  <span className="station-row-address">
                    {a.billingType === "prepaid" ? "Ön ödemeli" : "Sonradan fatura"}
                  </span>
                  {a.vkn && <span className="station-row-address">VKN {a.vkn}</span>}
                  <span className="station-row-address">{a.plates.length} araç</span>
                </span>
              </span>
              <span className="station-row-badges">
                <span className={`badge ${a.active ? "resolved" : "critical"}`}>{a.active ? "Aktif" : "Pasif"}</span>
              </span>
              <span className="fleet-row-amounts">
                <span className="fleet-row-balance">{formatCurrency(a.balance)}</span>
                <span className="hint-text">
                  {a.availableAmount !== null ? `Kullanılabilir ${formatCurrency(a.availableAmount)}` : "Limitsiz"}
                </span>
              </span>
              <span className="station-row-chevron">›</span>
            </button>
            <button type="button" className="ghost btn-sm fleet-row-action" onClick={() => toggleActive(a)}>
              {a.active ? "Pasife Al" : "Aktif Et"}
            </button>
          </div>
        ))}
        {accounts.length === 0 && <p className="hint-text">Henüz filo hesabı yok.</p>}
      </div>

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

/**
 * Ortak acilir pencere. Genislik SINIFLA verilir (styles.css): telefonda pencerenin
 * tam ekrana yakin acilmasi, kenar boslugunun kucultulmesi gibi kurallar tek yerde
 * duruyor - inline genislikle bunlar media query'ye giremiyordu.
 */
function Modal({ children, size = "sm" }: { children: React.ReactNode; size?: "sm" | "lg" | "xl" }) {
  return (
    <div className="modal-overlay">
      <div className={`modal-card${size === "sm" ? "" : ` modal-${size}`}`}>{children}</div>
    </div>
  );
}

function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [vkn, setVkn] = useState("");
  const [billingType, setBillingType] = useState<"prepaid" | "postpaid">("prepaid");
  const [creditLimit, setCreditLimit] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [lowBalanceThreshold, setLowBalanceThreshold] = useState("");
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
        contactEmail: contactEmail.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        lowBalanceThreshold: billingType === "prepaid" && lowBalanceThreshold ? Number(lowBalanceThreshold) : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Hesap oluşturulamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal size="lg">
      <h3>Yeni Filo Hesabı</h3>

      <label>Şirket Adı</label>
      <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoFocus />

      <label>VKN (opsiyonel)</label>
      <input value={vkn} onChange={(e) => setVkn(e.target.value)} />

      <label>Ödeme Tipi</label>
      <select value={billingType} onChange={(e) => setBillingType(e.target.value as "prepaid" | "postpaid")}>
        <option value="prepaid">Ön Ödemeli (bakiye yüklenir, harcandıkça düşer)</option>
        <option value="postpaid">Sonradan Fatura (borç birikir, aylık ödenir)</option>
      </select>

      {billingType === "postpaid" && (
        <>
          <label>Kredi Limiti (opsiyonel, boş = sınırsız)</label>
          <input type="number" min={0} step={0.01} value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
        </>
      )}

      <label>Yetkili E-posta (opsiyonel)</label>
      <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="ornek@sirket.com" />

      <label>Yetkili Telefon (opsiyonel)</label>
      <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="05XX XXX XX XX" />

      {billingType === "prepaid" && (
        <>
          <label>Düşük Bakiye Eşiği (opsiyonel, TL - boş = uyarı kapalı)</label>
          <input type="number" min={0} step={0.01} value={lowBalanceThreshold} onChange={(e) => setLowBalanceThreshold(e.target.value)} />
          <p className="hint-text">Bakiye bu tutarın altına düşünce yetkiliye otomatik e-posta/SMS gönderilir.</p>
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar" style={{ marginTop: "1.25rem" }}>
        <button type="button" onClick={onClose} disabled={submitting}>Vazgeç</button>
        <div className="spacer" />
        <button className="primary" disabled={submitting || !companyName.trim()} onClick={submit}>
          {submitting ? "Oluşturuluyor..." : "Oluştur"}
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
  const [portalUsers, setPortalUsers] = useState<PortalUser[]>([]);
  const [invoices, setInvoices] = useState<FleetInvoice[]>([]);
  const [invoiceDraft, setInvoiceDraft] = useState<FleetInvoiceDraft | null>(null);
  const [portalEmail, setPortalEmail] = useState("");
  /** Gecici sifre yalnizca olusturma/sifirlama yanitinda gelir; hicbir yerde saklanmaz. */
  const [temporaryPassword, setTemporaryPassword] = useState<{ email: string; password: string } | null>(null);
  const [newPlate, setNewPlate] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpNote, setTopUpNote] = useState("");
  const [contactEmail, setContactEmail] = useState(account?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(account?.contactPhone ?? "");
  const [lowBalanceThreshold, setLowBalanceThreshold] = useState(account?.lowBalanceThreshold?.toString() ?? "");
  const [contactSaved, setContactSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function loadMovements() {
    api.get<{ movements: FleetMovement[] }>(`/api/fleet-accounts/${accountId}/movements`).then((res) => setMovements(res.movements));
  }
  useEffect(loadMovements, [accountId]);

  function loadPortalUsers() {
    api.get<{ portalUsers: PortalUser[] }>(`/api/fleet-accounts/${accountId}/portal-users`).then((res) => setPortalUsers(res.portalUsers));
  }
  useEffect(loadPortalUsers, [accountId]);

  function loadInvoices() {
    api
      .get<{ invoices: FleetInvoice[]; draft: FleetInvoiceDraft }>(`/api/fleet-accounts/${accountId}/invoices`)
      .then((res) => {
        setInvoices(res.invoices);
        setInvoiceDraft(res.draft);
      })
      .catch(() => {
        setInvoices([]);
        setInvoiceDraft(null);
      });
  }
  useEffect(loadInvoices, [accountId]);

  async function createInvoice() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ invoice: FleetInvoice }>(`/api/fleet-accounts/${accountId}/invoices`);
      // Gonderim basarisiz olsa bile fatura kaydi olusur (durumu 'failed'); listeyi
      // yenilemek personelin tekrar deneyebilmesi icin gerekli.
      if (res.invoice.status === "failed") setError(`Fatura kesildi ama gonderilemedi: ${res.invoice.errorMessage ?? ""}`);
      loadInvoices();
      loadMovements();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Fatura kesilemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function retryInvoice(invoiceId: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ invoice: FleetInvoice }>(`/api/fleet-accounts/${accountId}/invoices/${invoiceId}/retry`);
      if (res.invoice.status === "failed") setError(`Yeniden gonderilemedi: ${res.invoice.errorMessage ?? ""}`);
      loadInvoices();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Yeniden gonderilemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function addPortalUser() {
    if (!portalEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ portalUser: PortalUser; temporaryPassword: string | null }>(
        `/api/fleet-accounts/${accountId}/portal-users`,
        { email: portalEmail.trim() }
      );
      // Sifre yalnizca YENI kullanicida doner; var olan bir kullanici bu hesaba baglandiysa
      // mevcut sifresi degistirilmez (baska istasyondaki erisimi bozardi).
      setTemporaryPassword(res.temporaryPassword ? { email: res.portalUser.email, password: res.temporaryPassword } : null);
      setPortalEmail("");
      loadPortalUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Portal kullanicisi eklenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPortalPassword(u: PortalUser) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ temporaryPassword: string }>(
        `/api/fleet-accounts/${accountId}/portal-users/${u.id}/reset-password`
      );
      setTemporaryPassword({ email: u.email, password: res.temporaryPassword });
      loadPortalUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Şifre sıfırlanamadı.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePortalUser(u: PortalUser) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/fleet-accounts/${accountId}/portal-users/${u.id}`, { active: !u.active });
      loadPortalUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function removePortalUser(u: PortalUser) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/fleet-accounts/${accountId}/portal-users/${u.id}`);
      loadPortalUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kaldırılamadı.");
    } finally {
      setBusy(false);
    }
  }

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

  async function saveContact() {
    setBusy(true);
    setError(null);
    setContactSaved(false);
    try {
      await api.patch(`/api/fleet-accounts/${accountId}/contact`, {
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        lowBalanceThreshold: lowBalanceThreshold ? Number(lowBalanceThreshold) : null,
      });
      setContactSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "İletişim bilgileri kaydedilemedi.");
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
      setError(err instanceof ApiError ? err.message : "İşlem yapılamadı.");
    } finally {
      setBusy(false);
    }
  }

  if (!account) return null;

  return (
    <Modal size="xl">
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>{account.companyName}</h3>
        <div className="spacer" />
        <button onClick={onClose}>Kapat</button>
      </div>
      <p className="hint-text">
        {account.billingType === "prepaid" ? "Ön ödemeli" : "Sonradan fatura"} - Bakiye/Borç: {formatCurrency(account.balance)}
        {account.availableAmount !== null && ` - Kullanılabilir: ${formatCurrency(account.availableAmount)}`}
      </p>
      {error && <p className="error-text">{error}</p>}

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>
          <h4>Plakalar</h4>
          <div className="toolbar">
            <input value={newPlate} onChange={(e) => setNewPlate(e.target.value.toUpperCase())} placeholder="34 ABC 123" />
            <button onClick={addPlate} disabled={busy}>Ekle</button>
          </div>
          {/* Her plaka bir SATIR degil, kendi genisligi kadar bir rozet: 10 arac
              satir duzeninde pencereyi tasiriyordu, rozet duzeninde iki satira siginir. */}
          <ul className="plate-chips">
            {account.plates.map((p) => (
              <li key={p.id} className="plate-chip">
                <span dir="ltr">{p.plate}</span>
                <button
                  type="button"
                  onClick={() => removePlate(p.id)}
                  disabled={busy}
                  aria-label={`${p.plate} plakasını kaldır`}
                  title="Kaldır"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {account.plates.length === 0 && <p className="hint-text">Henüz plaka eklenmedi.</p>}
          {account.plates.length > 0 && (
            <p className="hint-text">{account.plates.length} araç · plakayı kaldırmak için ×</p>
          )}
        </div>

        <div>
          <h4>{account.billingType === "prepaid" ? "Bakiye Yükle" : "Ödeme Kaydet (borç kapama)"}</h4>
          <label>Tutar (TL)</label>
          <input type="number" min={0} step={0.01} value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} />
          <label>Not (opsiyonel)</label>
          <input value={topUpNote} onChange={(e) => setTopUpNote(e.target.value)} />
          <button className="primary" style={{ marginTop: "0.75rem" }} onClick={submitTopUp} disabled={busy}>
            {account.billingType === "prepaid" ? "Bakiye Yükle" : "Ödeme Kaydet"}
          </button>
        </div>
      </div>

      <h4>İletişim / Düşük Bakiye Uyarısı</h4>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>
          <label>Yetkili E-posta</label>
          <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="ornek@sirket.com" />
        </div>
        <div>
          <label>Yetkili Telefon</label>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="05XX XXX XX XX" />
        </div>
      </div>
      {account.billingType === "prepaid" && (
        <>
          <label>Düşük Bakiye Eşiği (TL, boş = uyarı kapalı)</label>
          <input type="number" min={0} step={0.01} value={lowBalanceThreshold} onChange={(e) => setLowBalanceThreshold(e.target.value)} />
        </>
      )}
      <div className="toolbar" style={{ marginTop: "0.75rem" }}>
        {contactSaved && <span className="hint-text">Kaydedildi.</span>}
        <div className="spacer" />
        <button onClick={saveContact} disabled={busy}>İletişim Bilgilerini Kaydet</button>
      </div>

      <h4>Dönem Faturası</h4>
      <p className="hint-text">
        Kurumsal müşteriye her dolum için ayrı fiş değil, biriken hareketler için şirketin kendi VKN'siyle{" "}
        <strong>tek e-Fatura</strong> kesilir. Kapsam tarihle değil, <em>henüz faturalanmamış hareketlerle</em>
        {" "}belirlenir; geç fark edilen bir hareket sıradaki faturaya düşer, hiçbir hareket iki kez faturalanmaz.
      </p>
      {!account.vkn && <p className="error-text">Fatura kesebilmek için hesaba VKN girilmelidir.</p>}
      {invoiceDraft && (
        <div className="card">
          {invoiceDraft.movementCount === 0 ? (
            <span className="hint-text">Faturalanacak yeni hareket yok.</span>
          ) : (
            <>
              <strong>
                Bekleyen: {invoiceDraft.movementCount} hareket · {formatCurrency(invoiceDraft.payableAmount)}
              </strong>
              <div className="hint-text">
                {invoiceDraft.totalLiters.toFixed(2)} L · KDV hariç {formatCurrency(invoiceDraft.taxExclusiveAmount)} + KDV{" "}
                {formatCurrency(invoiceDraft.taxAmount)}
                {invoiceDraft.periodStart && ` · ${formatDateTime(invoiceDraft.periodStart)} — ${formatDateTime(invoiceDraft.periodEnd)}`}
              </div>
              <div className="table-scroll">
                <table style={{ marginTop: "0.75rem" }}>
                  <thead>
                    <tr><th>Plaka</th><th>Yakıt</th><th className="numeric">Litre</th><th className="numeric">Tutar</th></tr>
                  </thead>
                  <tbody>
                    {invoiceDraft.lines.map((l) => (
                      <tr key={`${l.plate}-${l.fuelType}`}>
                        <td>{l.plate}</td>
                        <td>{l.fuelType}</td>
                        <td className="numeric">{l.liters.toFixed(2)}</td>
                        <td className="numeric">{formatCurrency(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="toolbar" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                <div className="spacer" />
                <button className="primary" onClick={createInvoice} disabled={busy || !account.vkn}>
                  Fatura Kes
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {invoices.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Tarih</th><th>Dönem</th><th className="numeric">Tutar</th><th>Durum</th><th></th></tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{formatDateTime(i.createdAt)}</td>
                  <td className="hint-text">
                    {i.periodStart.slice(0, 10)} — {i.periodEnd.slice(0, 10)}
                  </td>
                  <td className="numeric">{formatCurrency(i.payableAmount)}</td>
                  <td>
                    {i.status === "sent" ? (
                      <span className="badge resolved">Gönderildi</span>
                    ) : i.status === "failed" ? (
                      <span className="badge critical" title={i.errorMessage ?? undefined}>Başarısız</span>
                    ) : (
                      <span className="badge warning">Bekliyor</span>
                    )}
                    {i.providerInvoiceId && <div className="hint-text"><code>{i.providerInvoiceId}</code></div>}
                  </td>
                  <td>
                    {i.status !== "sent" && (
                      <button onClick={() => retryInvoice(i.id)} disabled={busy}>Yeniden Gönder</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Portal Erişimi</h4>
      <p className="hint-text">
        Şirket yetkilisi aşağıdaki adresten kendi bakiyesini, ekstresini, faturalarını ve araç bazında
        harcamalarını (hangi plaka, ne zaman, ne kadar) kendisi görür — istasyonu aramasına gerek kalmaz.
        Portal salt okunurdur: bakiye yükleme burada, istasyonda kalır.
      </p>
      {/* Personelin musteriye gonderecegi sey "/filo" degil, tam adres. Elle yazdirmak
          yerine tek tikla kopyalanir. */}
      <p className="with-action">
        <code>{`${window.location.origin}/filo`}</code>
        <button
          type="button"
          className="ghost btn-sm"
          onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/filo`)}
        >
          Adresi kopyala
        </button>
      </p>
      <div className="toolbar">
        <input
          type="email"
          value={portalEmail}
          onChange={(e) => setPortalEmail(e.target.value)}
          placeholder="yetkili@sirket.com"
          style={{ minWidth: 240 }}
        />
        <button onClick={addPortalUser} disabled={busy || !portalEmail.trim()}>Portal Erişimi Ver</button>
      </div>
      {temporaryPassword && (
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <strong>Geçici şifre — bu ekran kapanınca bir daha gösterilemez.</strong>
          <p className="hint-text" style={{ marginBottom: "0.35rem" }}>
            {temporaryPassword.email} kullanıcısına iletin; ilk girişinde kendi şifresini belirleyecek.
          </p>
          <code style={{ fontSize: "1.1rem", userSelect: "all" }}>{temporaryPassword.password}</code>
          <div className="toolbar" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            <div className="spacer" />
            <button onClick={() => setTemporaryPassword(null)}>Gizle</button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>E-posta</th><th>Durum</th><th>Son Giriş</th><th></th></tr>
          </thead>
          <tbody>
            {portalUsers.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  {!u.active ? (
                    <span className="badge cancelled">Devre dışı</span>
                  ) : u.locked ? (
                    <span className="badge critical">Kilitli</span>
                  ) : u.mustChangePassword ? (
                    <span className="badge warning">Şifre bekliyor</span>
                  ) : (
                    <span className="badge resolved">Aktif</span>
                  )}
                </td>
                <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="hint-text">Hiç girmedi</span>}</td>
                <td className="toolbar" style={{ margin: 0, justifyContent: "flex-end" }}>
                  <button onClick={() => resetPortalPassword(u)} disabled={busy}>Şifre Sıfırla</button>
                  <button onClick={() => togglePortalUser(u)} disabled={busy}>{u.active ? "Devre Dışı" : "Etkinleştir"}</button>
                  <button onClick={() => removePortalUser(u)} disabled={busy}>Kaldır</button>
                </td>
              </tr>
            ))}
            {portalUsers.length === 0 && <tr><td colSpan={4} className="hint-text">Portal erişimi verilmemiş.</td></tr>}
          </tbody>
        </table>
      </div>

      <h4>Hareket Geçmişi</h4>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Tarih</th><th>Tip</th><th className="numeric">Tutar</th><th className="numeric">Sonraki Bakiye</th><th>Not</th><th>Kullanıcı</th></tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{formatDateTime(m.createdAt)}</td>
                <td>{MOVEMENT_LABEL[m.type]}</td>
                <td className="numeric">{formatCurrency(m.amount)}</td>
                <td className="numeric">{formatCurrency(m.balanceAfter)}</td>
                <td>{m.note ?? (m.transactionId ? `İşlem #${m.transactionId}` : "-")}</td>
                <td>{m.username ?? "-"}</td>
              </tr>
            ))}
            {movements.length === 0 && <tr><td colSpan={6} className="hint-text">Henüz hareket yok.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
