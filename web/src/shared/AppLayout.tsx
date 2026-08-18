import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import ChangePasswordBanner from "../pages/ChangePasswordBanner";

const ROLE_LABEL: Record<string, string> = { admin: "Yonetici", operator: "Operator", viewer: "Izleyici" };

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/giris", { replace: true });
  }

  if (!user) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Yakit Istasyonu</h1>
        <p className="brand-sub">Yonetim Sistemi</p>
        <nav>
          <p className="section-label">Operator</p>
          <NavLink to="/operator" end>Panel</NavLink>
          <NavLink to="/operator/pompalar">Pompalar</NavLink>
          <NavLink to="/operator/islemler">Islem Listesi</NavLink>
          <NavLink to="/operator/alarmlar">Alarm Merkezi</NavLink>
          <NavLink to="/operator/harita">Istasyon Haritasi</NavLink>
          <NavLink to="/operator/raporlar">Raporlama</NavLink>

          {user.role === "admin" && (
            <>
              <p className="section-label">Yonetici</p>
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
          <div>
            <strong>{user.displayName}</strong>{" "}
            <span className="hint-text">({ROLE_LABEL[user.role] ?? user.role})</span>
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <NavLink to="/operator/sifre-degistir"><button className="ghost">Sifre Degistir</button></NavLink>
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
