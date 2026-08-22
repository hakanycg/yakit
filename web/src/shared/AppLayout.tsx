import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
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

/** Sidebar'in en altindaki hesap karti - tiklaninca "Hesabim"/"Cikis Yap" acilir menusunu gosterir. */
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
          <NavLink to="/operator/sifre-degistir" className="sidebar-dropdown-item" onClick={() => setOpen(false)}>
            Hesabım
          </NavLink>
          <button type="button" className="sidebar-dropdown-item danger" onClick={onLogout}>
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
              <NavLink to="/admin/kampanyalar">Kampanyalar</NavLink>
              <NavLink to="/admin/filo-hesaplari">Filo Hesapları</NavLink>
              <NavLink to="/admin/sadakat-puanlari">Sadakat Puanları</NavLink>
              <NavLink to="/admin/kvkk">KVKK Başvuruları</NavLink>
              <NavLink to="/admin/kullanicilar">Kullanıcı / Rol Yönetimi</NavLink>
              <NavLink to="/admin/ayarlar">Ayarlar</NavLink>
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
