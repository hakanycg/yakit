import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import ChangePasswordBanner from "../pages/ChangePasswordBanner";
import StationSwitcher from "./StationSwitcher";
import { useCriticalAlarmNotifications } from "./useCriticalAlarmNotifications";
import { useThemePreference } from "./useThemePreference";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Platform Yöneticisi",
  admin: "İstasyon Yöneticisi",
  operator: "Operator",
  viewer: "İzleyici",
};

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
        <h1>Yakıt İstasyonu</h1>
        <p className="brand-sub">Yönetim Sistemi</p>
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
      </aside>
      <div className="main-content">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <button className="menu-toggle ghost" aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
              &#9776;
            </button>
            <div>
              <strong>{user.displayName}</strong>{" "}
              <span className="hint-text">({ROLE_LABEL[user.role] ?? user.role})</span>
            </div>
            {isSuperAdmin && <StationSwitcher />}
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button
              className="ghost"
              onClick={() => setThemeMode(themeMode === "night" ? "day" : "night")}
              title={themeMode === "night" ? "Açık temaya geç" : "Koyu temaya geç"}
              aria-label={themeMode === "night" ? "Açık temaya geç" : "Koyu temaya geç"}
            >
              {themeMode === "night" ? "☀️" : "🌙"}
            </button>
            <NavLink to="/operator/sifre-degistir"><button className="ghost">Hesabım</button></NavLink>
            <button onClick={handleLogout}>Çıkış Yap</button>
          </div>
        </header>
        <ChangePasswordBanner />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
