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

      <table>
        <thead>
          <tr>
            <th>Şirket</th><th>VKN</th><th>Ödeme Tipi</th><th className="numeric">Bakiye/Borç</th>
            <th className="numeric">Kullanılabilir</th><th>Plakalar</th><th>Durum</th><th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.companyName}</strong></td>
              <td>{a.vkn ?? "-"}</td>
              <td>{a.billingType === "prepaid" ? "Ön Ödemeli" : "Sonradan Fatura"}</td>
              <td className="numeric">{formatCurrency(a.balance)}</td>
              <td className="numeric">{a.availableAmount !== null ? formatCurrency(a.availableAmount) : "Sınırsız"}</td>
              <td>{a.plates.length}</td>
              <td><span className={`badge ${a.active ? "resolved" : "critical"}`}>{a.active ? "Aktif" : "Pasif"}</span></td>
              <td className="toolbar">
                <button onClick={() => setDetailId(a.id)}>Detay</button>
                <button onClick={() => toggleActive(a)}>{a.active ? "Pasife Al" : "Aktif Et"}</button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={8} className="hint-text">Henüz filo hesabı yok.</td></tr>}
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
    <Modal>
      <h3 style={{ marginTop: 0 }}>Yeni Filo Hesabı</h3>

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
    <Modal wide>
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
          <ul style={{ listStyle: "none", padding: 0, marginTop: "0.75rem" }}>
            {account.plates.map((p) => (
              <li key={p.id} className="toolbar" style={{ padding: "0.35rem 0" }}>
                <span dir="ltr">{p.plate}</span>
                <div className="spacer" />
                <button onClick={() => removePlate(p.id)} disabled={busy}>Kaldır</button>
              </li>
            ))}
            {account.plates.length === 0 && <li className="hint-text">Henüz plaka eklenmedi.</li>}
          </ul>
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

      <h4 style={{ marginTop: "1.5rem" }}>İletişim / Düşük Bakiye Uyarısı</h4>
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

      <h4 style={{ marginTop: "1.5rem" }}>Portal Erişimi</h4>
      <p className="hint-text">
        Şirket yetkilisi <code>/filo</code> adresinden kendi bakiyesini, ekstresini ve araç bazında harcamalarını
        görebilir. Portal salt okunurdur: bakiye yükleme burada, istasyonda kalır.
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

      <h4 style={{ marginTop: "1.5rem" }}>Hareket Geçmişi</h4>
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
