import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import ChangePasswordBanner from "../pages/ChangePasswordBanner";
import StationSwitcher from "./StationSwitcher";
import { useCriticalAlarmNotifications } from "./useCriticalAlarmNotifications";
import { useThemePreference } from "./useThemePreference";
import { initials } from "./format";
import { MenuIcon, MoonIcon, SunIcon } from "./icons";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Platform Yöneticisi",
  admin: "İstasyon Yöneticisi",
  operator: "Operator",
  viewer: "İzleyici",
};

/** Sidebar'daki "Ayarlar" acilir menusundeki sayfalar (bkz. App.tsx /admin/ayarlar/* rotalari). */
const SETTINGS_PAGES = [
  { to: "/admin/ayarlar/yakit-fiyatlari", label: "Yakıt Fiyatları" },
  { to: "/admin/ayarlar/odeme", label: "Ödeme (iyzico)" },
  { to: "/admin/ayarlar/sadakat", label: "Sadakat / Puan" },
  { to: "/admin/ayarlar/fatura", label: "Fatura / İrsaliye" },
  { to: "/admin/ayarlar/ozet-raporu", label: "Otomatik Özet Raporu" },
  { to: "/admin/ayarlar/istasyon-ajani", label: "İstasyon Ajanı" },
];

/**
 * Sidebar'da tek bir link yerine, tiklaninca alt sayfalarini acan menu basligi.
 * Menu HER ZAMAN kapali baslar; yalnizca kullanici tiklayinca acilir (bulunulan
 * sayfa bu grubun icinde olsa bile kendiliginden acilmaz). Hangi grupta
 * oldugunuz, baslikta "active" vurgusuyla belli olur.
 */
function SidebarSubmenu({ label, pages, onNavigate }: { label: string; pages: { to: string; label: string }[]; onNavigate: () => void }) {
  const { pathname } = useLocation();
  const containsActive = pages.some((p) => pathname.startsWith(p.to));
  const [open, setOpen] = useState(false);

  return (
    <div className="sidebar-submenu">
      <button
        type="button"
        className={`sidebar-submenu-trigger${containsActive ? " active" : ""}`}
        // <nav> uzerindeki tiklama mobilde sidebar'i kapatiyor; alt menuyu acmak
        // bir gezinme degil, o yuzden bu tiklamanin yukari kabarmasi engelleniyor.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span>{label}</span>
        <span className={`sidebar-chevron${open ? " open" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="sidebar-submenu-items">
          {pages.map((p) => (
            <NavLink key={p.to} to={p.to} onClick={onNavigate}>
              {p.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** Hesap kartinin acilir menusundeki sayfalar (bkz. App.tsx /operator/hesabim/* rotalari). */
const ACCOUNT_PAGES = [
  { to: "/operator/hesabim/sifre", label: "Şifre Değiştir" },
  { to: "/operator/hesabim/iki-adimli-dogrulama", label: "İki Adımlı Doğrulama" },
  { to: "/operator/hesabim/oturumlar", label: "Aktif Oturumlar" },
  { to: "/operator/hesabim/bildirimler", label: "Bildirim Ayarları" },
];

/** Sidebar'in en altindaki hesap karti - tiklaninca hesap sayfalari + "Cikis Yap" acilir menusunu gosterir. */
function SidebarAccountCard({ onLogout }: { onLogout: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  return (
    <div className="sidebar-org-card sidebar-account-card" ref={boxRef}>
      {open && (
        <div className="sidebar-dropdown sidebar-dropdown-up">
          {ACCOUNT_PAGES.map((p) => (
            <NavLink
              key={p.to}
              to={p.to}
              className={({ isActive }) => `sidebar-dropdown-item${isActive ? " active" : ""}`}
              onClick={() => setOpen(false)}
            >
              {p.label}
            </NavLink>
          ))}
          <div className="sidebar-dropdown-sep" />
          <button type="button" className="sidebar-dropdown-item sidebar-dropdown-item--danger" onClick={onLogout}>
            Çıkış Yap
          </button>
        </div>
      )}
      <button type="button" className="sidebar-card-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="sidebar-avatar">{initials(user.displayName)}</span>
        <span className="sidebar-card-text">
          <strong>{user.displayName}</strong>
          <span className="hint-text">{ROLE_LABEL[user.role] ?? user.role}</span>
        </span>
        <span className={`sidebar-chevron${open ? " open" : ""}`}>▾</span>
      </button>
    </div>
  );
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeMode, setThemeMode] = useThemePreference();
  useCriticalAlarmNotifications();

  async function handleLogout() {
    await logout();
    navigate("/giris", { replace: true });
  }

  if (!user) return null;

  const isSuperAdmin = user.role === "super_admin";
  const isStationAdmin = user.role === "admin" || isSuperAdmin;

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-overlay" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <StationSwitcher />
        <nav onClick={() => setMenuOpen(false)}>
          {isSuperAdmin && (
            <>
              <p className="section-label">Platform</p>
              <NavLink to="/admin/istasyonlar">İstasyonlar</NavLink>
              <NavLink to="/admin/kiosk-filosu">Kiosk Filosu</NavLink>
              <NavLink to="/admin/audit-log">Audit Log</NavLink>
              <NavLink to="/admin/sifirla">Demo Verilerini Sıfırla</NavLink>
            </>
          )}

          <p className="section-label">Operator</p>
          <NavLink to="/operator" end>Genel Bakış</NavLink>
          <NavLink to="/operator/pompalar">Pompalar</NavLink>
          <NavLink to="/operator/islemler">İşlem Listesi</NavLink>
          <NavLink to="/operator/alarmlar">Alarm Merkezi</NavLink>
          <NavLink to="/operator/harita">İstasyon Haritası</NavLink>
          <NavLink to="/operator/raporlar">Raporlama</NavLink>
          <NavLink to="/operator/vardiya">Vardiya</NavLink>

          {isStationAdmin && (
            <>
              <p className="section-label">İstasyon Yönetimi</p>
              <NavLink to="/operator/stok">Yakıt Stoku</NavLink>
              <NavLink to="/operator/sapma">Yakıt Sapma</NavLink>
              <NavLink to="/admin/kampanyalar">Kampanyalar</NavLink>
              <NavLink to="/admin/filo-hesaplari">Filo Hesapları</NavLink>
              <NavLink to="/admin/sadakat-puanlari">Sadakat Puanları</NavLink>
              <NavLink to="/admin/kvkk">KVKK Başvuruları</NavLink>
              <NavLink to="/admin/kullanicilar">Kullanıcı / Rol Yönetimi</NavLink>
              <SidebarSubmenu label="Ayarlar" pages={SETTINGS_PAGES} onNavigate={() => setMenuOpen(false)} />
            </>
          )}
        </nav>
        <SidebarAccountCard onLogout={handleLogout} />
      </aside>
      <div className="main-content">
        <header className="topbar">
          <button className="menu-toggle icon-btn" aria-label="Menü" onClick={() => setMenuOpen((v) => !v)}>
            <MenuIcon />
          </button>
          <div className="spacer" />
          <button
            className="icon-btn"
            onClick={() => setThemeMode(themeMode === "night" ? "day" : "night")}
            title={themeMode === "night" ? "Açık temaya geç" : "Koyu temaya geç"}
            aria-label={themeMode === "night" ? "Açık temaya geç" : "Koyu temaya geç"}
          >
            {themeMode === "night" ? <SunIcon /> : <MoonIcon />}
          </button>
        </header>
        <ChangePasswordBanner />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
