import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import ChangePasswordBanner from "../pages/ChangePasswordBanner";
import StationSwitcher from "./StationSwitcher";
import { useCriticalAlarmNotifications } from "./useCriticalAlarmNotifications";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Platform Yoneticisi",
  admin: "Istasyon Yoneticisi",
  operator: "Operator",
  viewer: "Izleyici",
};

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
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
      <aside className="sidebar">
        <h1>Yakit Istasyonu</h1>
        <p className="brand-sub">Yonetim Sistemi</p>
        <nav>
          {isSuperAdmin && (
            <>
              <p className="section-label">Platform</p>
              <NavLink to="/admin/istasyonlar">Istasyonlar</NavLink>
            </>
          )}

          <p className="section-label">Operator</p>
          <NavLink to="/operator" end>Panel</NavLink>
          <NavLink to="/operator/pompalar">Pompalar</NavLink>
          <NavLink to="/operator/islemler">Islem Listesi</NavLink>
          <NavLink to="/operator/alarmlar">Alarm Merkezi</NavLink>
          <NavLink to="/operator/harita">Istasyon Haritasi</NavLink>
          <NavLink to="/operator/raporlar">Raporlama</NavLink>
          <NavLink to="/operator/vardiya">Vardiya</NavLink>

          {isStationAdmin && (
            <>
              <p className="section-label">Istasyon Yonetimi</p>
              <NavLink to="/operator/stok">Yakit Stoku</NavLink>
              <NavLink to="/admin/kullanicilar">Kullanici / Rol Yonetimi</NavLink>
              <NavLink to="/admin/audit-log">Audit Log</NavLink>
              <NavLink to="/admin/ayarlar">Ayarlar</NavLink>
              <NavLink to="/admin/sifirla">Demo Verilerini Sifirla</NavLink>
            </>
          )}
        </nav>
      </aside>
      <div className="main-content">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <div>
              <strong>{user.displayName}</strong>{" "}
              <span className="hint-text">({ROLE_LABEL[user.role] ?? user.role})</span>
            </div>
            {isSuperAdmin && <StationSwitcher />}
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <NavLink to="/operator/sifre-degistir"><button className="ghost">Hesabim</button></NavLink>
            <button onClick={handleLogout}>Cikis Yap</button>
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
