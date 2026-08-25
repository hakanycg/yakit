import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../shared/api";
import { formatCurrency, formatDateTime, formatLiters } from "../shared/format";
import { useThemePreference } from "../shared/useThemePreference";
import { AlertIcon, CheckCircleIcon, FuelIcon, MoonIcon, SunIcon, WalletIcon } from "../shared/icons";
import { fleetApi, type PlateSummary, type PortalAccount, type PortalUser, type Statement } from "./fleetApi";

/**
 * Filo musteri self-servis portali (/filo).
 *
 * Yonetim panelinin ICINDE degil, AYRI bir sayfadir: buraya giren kisi personel
 * degildir, kendi sirketinden baska hicbir sey goremez ve hicbir sey yazamaz
 * (kendi sifresi haric). Kimlik dogrulamasi da ayri bir cerezle yurur, bu yuzden
 * AuthContext/AppLayout kullanilmaz.
 */

/** Turkiye UTC+3; is gunu yerel gece yarisinda baslar - sunucudakiyle ayni tanim. */
function businessDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3600_000 - daysAgo * 86400_000).toISOString().slice(0, 10);
}

export default function FleetPortal() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((next: { user: PortalUser; accounts: PortalAccount[] }) => {
    setUser(next.user);
    setAccounts(next.accounts);
  }, []);

  useEffect(() => {
    fleetApi
      .get<{ user: PortalUser; accounts: PortalAccount[] }>("/api/fleet-portal/me")
      .then(applySession)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [applySession]);

  async function handleLogout() {
    await fleetApi.post("/api/fleet-portal/logout").catch(() => {});
    setUser(null);
    setAccounts([]);
  }

  if (loading) return <div className="login-shell" />;
  if (!user) return <FleetLogin onSuccess={applySession} />;
  // Gecici sifreyle giren kullanici once sifresini degistirir: gecici sifre telefonla/
  // e-postayla iletildigi icin kalici olarak kullanilmasi dogru olmaz.
  if (user.mustChangePassword) return <ChangePassword onDone={handleLogout} />;

  return <FleetDashboard user={user} accounts={accounts} onLogout={handleLogout} />;
}

// ---------------------------------------------------------------------------

function FleetLogin({ onSuccess }: { onSuccess: (s: { user: PortalUser; accounts: PortalAccount[] }) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      onSuccess(await fleetApi.post<{ user: PortalUser; accounts: PortalAccount[] }>("/api/fleet-portal/login", { email, password }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Giriş başarısız oldu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Filo Müşteri Girişi</h2>
        <p className="hint-text">Şirketinizin yakıt hesabını, bakiyesini ve araç bazında harcamalarını görün.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="fp-email">E-posta</label>
          <input id="fp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          <label htmlFor="fp-password">Şifre</label>
          <input
            id="fp-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={submitting}>
            {submitting ? "Giriş yapılıyor..." : "Giriş Yap"}
          </button>
        </form>
        <p className="hint-text" style={{ marginTop: "1rem", textAlign: "center" }}>
          Giriş bilgilerinizi yakıt aldığınız istasyondan alabilirsiniz.
        </p>
      </div>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== repeat) {
      setError("Yeni şifreler birbiriyle uyuşmuyor.");
      return;
    }
    try {
      await fleetApi.post("/api/fleet-portal/password", { currentPassword, newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Şifre değiştirilemedi.");
    }
  }

  if (done) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h2>Şifreniz Değiştirildi</h2>
          <p className="hint-text">Güvenliğiniz için tüm oturumlar kapatıldı. Yeni şifrenizle giriş yapın.</p>
          <button type="button" className="primary" style={{ width: "100%", marginTop: "1.5rem" }} onClick={onDone}>
            Giriş Ekranına Dön
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2>Şifrenizi Belirleyin</h2>
        <p className="hint-text">Size verilen geçici şifre yerine kendi şifrenizi belirlemeniz gerekiyor.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="cp-current">Geçici şifre</label>
          <input id="cp-current" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus required />
          <label htmlFor="cp-new">Yeni şifre</label>
          <input id="cp-new" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          <label htmlFor="cp-repeat">Yeni şifre (tekrar)</label>
          <input id="cp-repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" style={{ width: "100%", marginTop: "1.5rem" }}>
            Kaydet
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FleetDashboard({ user, accounts, onLogout }: { user: PortalUser; accounts: PortalAccount[]; onLogout: () => void }) {
  const [themeMode, setThemeMode] = useThemePreference();
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.accountId ?? null);
  const [from, setFrom] = useState(() => businessDate(29));
  const [to, setTo] = useState(() => businessDate(0));
  const [plateFilter, setPlateFilter] = useState("");
  const [statement, setStatement] = useState<Statement | null>(null);
  const [plates, setPlates] = useState<PlateSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.accountId === accountId) ?? null;

  useEffect(() => {
    if (accountId === null) return;
    const plateParam = plateFilter ? `&plate=${encodeURIComponent(plateFilter)}` : "";
    setError(null);
    fleetApi
      .get<{ statement: Statement }>(`/api/fleet-portal/accounts/${accountId}/statement?from=${from}&to=${to}${plateParam}`)
      .then((r) => setStatement(r.statement))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Ekstre yüklenemedi."));
  }, [accountId, from, to, plateFilter]);

  // Arac ozeti plaka filtresinden ETKILENMEZ: filtre ekstreyi daraltir, aracin donem
  // toplamlarini degil. Ayni efekte konulsaydi her filtre degisiminde gereksiz yere
  // yeniden cekilirdi.
  useEffect(() => {
    if (accountId === null) return;
    fleetApi
      .get<{ plates: PlateSummary[] }>(`/api/fleet-portal/accounts/${accountId}/plate-breakdown?from=${from}&to=${to}`)
      .then((r) => setPlates(r.plates))
      .catch(() => setPlates([]));
  }, [accountId, from, to]);

  const t = statement?.totals;
  const lowBalance =
    account !== null &&
    account.billingType === "prepaid" &&
    account.lowBalanceThreshold !== null &&
    account.balance <= account.lowBalanceThreshold;

  return (
    <div className="fleet-portal">
      <header className="fleet-portal-header">
        <div>
          <strong>Filo Müşteri Portalı</strong>
          <div className="hint-text">{user.displayName ?? user.email}</div>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setThemeMode(themeMode === "night" ? "day" : "night")}
            aria-label={themeMode === "night" ? "Açık temaya geç" : "Koyu temaya geç"}
          >
            {themeMode === "night" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" onClick={onLogout}>
            Çıkış
          </button>
        </div>
      </header>

      <main className="fleet-portal-main">
        {accounts.length === 0 && (
          <div className="card">
            <p className="hint-text">
              Hesabınıza bağlı bir filo hesabı bulunamadı. Yakıt aldığınız istasyonla iletişime geçin.
            </p>
          </div>
        )}

        {accounts.length > 1 && (
          <div className="toolbar">
            <label htmlFor="fp-account" style={{ margin: 0 }}>
              Hesap
            </label>
            <select id="fp-account" value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.companyName} — {a.stationName}
                </option>
              ))}
            </select>
            <span className="hint-text">
              Şirketiniz birden fazla istasyonda yakıt alıyor; her istasyonun hesabı ayrı tutulur.
            </span>
          </div>
        )}

        {account && (
          <>
            <h2 style={{ marginBottom: "0.25rem" }}>{account.companyName}</h2>
            <p className="hint-text">
              {account.stationName} · {account.billingType === "prepaid" ? "Ön ödemeli" : "Faturalı (sonradan ödeme)"} ·{" "}
              {account.plateCount} araç
              {!account.active && " · hesap pasif"}
            </p>

            {lowBalance && (
              <div className="card" style={{ borderColor: "#f87171" }}>
                <strong style={{ color: "#f87171" }}>Bakiyeniz düşük.</strong>{" "}
                <span className="hint-text">
                  Kalan bakiye {formatCurrency(account.balance)}. Yükleme için yakıt aldığınız istasyonla iletişime geçin —
                  bakiye yüklemesi istasyon tarafından yapılır.
                </span>
              </div>
            )}

            <div className="grid stats-grid">
              <Stat
                label={account.billingType === "prepaid" ? "Kalan bakiye" : "Ödenmemiş borç"}
                value={formatCurrency(account.balance)}
                caption={
                  account.billingType === "prepaid"
                    ? account.lowBalanceThreshold !== null
                      ? `Uyarı eşiği ${formatCurrency(account.lowBalanceThreshold)}`
                      : "Ön ödemeli hesap"
                    : account.creditLimit !== null
                      ? `Kredi limiti ${formatCurrency(account.creditLimit)}`
                      : "Limitsiz"
                }
                tone={lowBalance ? "bad" : "neutral"}
                icon={<WalletIcon />}
              />
              <Stat
                label="Harcanabilir tutar"
                value={account.availableAmount === null ? "Limitsiz" : formatCurrency(account.availableAmount)}
                caption="Şu anda yakıt alınabilecek tutar"
                tone={account.availableAmount !== null && account.availableAmount <= 0 ? "bad" : "ok"}
                icon={account.availableAmount !== null && account.availableAmount <= 0 ? <AlertIcon /> : <CheckCircleIcon />}
              />
              <Stat
                label="Dönem harcaması"
                value={t ? formatCurrency(t.netSpend) : "..."}
                caption={t ? `${t.fillCount} dolum · ${formatCurrency(t.refunded)} iade` : ""}
                tone="neutral"
                icon={<WalletIcon />}
              />
              <Stat
                label="Dönem yakıt"
                value={t ? formatLiters(t.liters) : "..."}
                caption={t ? `${formatCurrency(t.toppedUp)} bakiye yüklendi` : ""}
                tone="neutral"
                icon={<FuelIcon />}
              />
            </div>

            <div className="toolbar">
              <label htmlFor="fp-from" style={{ margin: 0 }}>
                Başlangıç
              </label>
              <input id="fp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
              <label htmlFor="fp-to" style={{ margin: 0 }}>
                Bitiş
              </label>
              <input id="fp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
              {/* Serbest metin yerine kendi plakalarindan secim: "34" yazip bos tablo
                  gormek, filtrenin bozuk oldugunu dusundururdu - eslesme tam olmali. */}
              <select
                aria-label="Plaka ile filtrele"
                value={plateFilter}
                onChange={(e) => setPlateFilter(e.target.value)}
                style={{ width: 200 }}
              >
                <option value="">Tüm araçlar</option>
                {plates.map((p) => (
                  <option key={p.plate} value={p.plate}>
                    {p.plate}
                  </option>
                ))}
              </select>
              <div className="spacer" />
              <a href={`/api/fleet-portal/accounts/${account.accountId}/statement.csv?from=${from}&to=${to}`}>
                <button type="button">CSV İndir</button>
              </a>
            </div>

            {error && <p className="error-text">{error}</p>}

            <h3>Araç Bazında Harcama</h3>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Plaka</th>
                    <th>Dolum</th>
                    <th>Litre</th>
                    <th>Tutar</th>
                    <th>Son dolum</th>
                  </tr>
                </thead>
                <tbody>
                  {plates.map((p) => (
                    <tr key={p.plate}>
                      <td>
                        <strong>{p.plate}</strong>
                      </td>
                      <td>{p.fillCount}</td>
                      <td>{formatLiters(p.liters)}</td>
                      <td>{formatCurrency(p.amount)}</td>
                      <td className="hint-text">{p.lastFillAt ? formatDateTime(p.lastFillAt) : "—"}</td>
                    </tr>
                  ))}
                  {plates.length === 0 && (
                    <tr>
                      <td colSpan={5} className="hint-text">
                        Bu hesaba kayıtlı araç yok.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <h3>Hesap Ekstresi</h3>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>İşlem</th>
                    <th>Plaka</th>
                    <th>Yakıt</th>
                    <th>Tutar</th>
                    <th>Sonraki bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {(statement?.rows ?? []).map((r) => (
                    <tr key={r.id}>
                      <td className="hint-text">{formatDateTime(r.createdAt)}</td>
                      <td>
                        <span className={`badge ${movementBadge(r.type)}`}>{movementLabel(r.type)}</span>
                        {r.note && <div className="hint-text">{r.note}</div>}
                      </td>
                      <td>{r.plate ?? <span className="hint-text">—</span>}</td>
                      <td>
                        {r.liters !== null ? (
                          <>
                            {formatLiters(r.liters)}
                            <div className="hint-text">
                              {r.fuelType} · {r.pricePerLiter !== null ? `${formatCurrency(r.pricePerLiter)}/L` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="hint-text">—</span>
                        )}
                      </td>
                      <td>
                        <strong>
                          {r.type === "charge" ? "−" : "+"}
                          {formatCurrency(r.amount)}
                        </strong>
                      </td>
                      <td className="hint-text">{formatCurrency(r.balanceAfter)}</td>
                    </tr>
                  ))}
                  {statement !== null && statement.rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="hint-text">
                        Seçilen tarih aralığında hareket yok.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function movementLabel(type: string): string {
  return { topup: "Bakiye yükleme", charge: "Yakıt alımı", refund: "İade", adjustment: "Düzeltme" }[type] ?? type;
}

function movementBadge(type: string): string {
  return { topup: "resolved", charge: "info", refund: "warning", adjustment: "warning" }[type] ?? "info";
}

function Stat({
  label,
  value,
  caption,
  tone,
  icon,
}: {
  label: string;
  value: string;
  caption: string;
  tone: "ok" | "bad" | "neutral";
  icon: React.ReactNode;
}) {
  const palette = {
    ok: { background: "rgba(34,197,94,0.15)", color: "#4ade80" },
    bad: { background: "rgba(248,113,113,0.15)", color: "#f87171" },
    neutral: { background: "rgba(58,160,255,0.15)", color: "var(--accent)" },
  }[tone];

  return (
    <div className="card stat dash-stat">
      <div className="stat-icon" style={palette}>
        {icon}
      </div>
      <div className="stat-body">
        <span className="label">{label}</span>
        <span className="value" style={tone === "bad" ? { color: "#f87171" } : undefined}>
          {value}
        </span>
        <span className="stat-caption">{caption}</span>
      </div>
    </div>
  );
}
