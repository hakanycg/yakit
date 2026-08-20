import { Navigate, Route, Routes } from "react-router-dom";
import KioskFlow from "./kiosk/KioskFlow";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Unauthorized from "./pages/Unauthorized";
import AppLayout from "./shared/AppLayout";
import { RequireRole } from "./shared/RequireRole";
import Dashboard from "./pages/operator/Dashboard";
import Pumps from "./pages/operator/Pumps";
import Transactions from "./pages/operator/Transactions";
import Alarms from "./pages/operator/Alarms";
import StationMap from "./pages/operator/StationMap";
import Reports from "./pages/operator/Reports";
import ChangePassword from "./pages/operator/ChangePassword";
// Vardiya sistemi gecici olarak devre disi - bkz. asagidaki route. Kodu (Shift.tsx) silinmedi,
// sadece erisim kapatildi; geri acmak icin bu import'u ve ilgili <Route>'u geri getirin.
// import Shift from "./pages/operator/Shift";
import FuelStock from "./pages/operator/FuelStock";
import DiscountCodes from "./pages/admin/DiscountCodes";
import LoyaltyLookup from "./pages/admin/LoyaltyLookup";
import Users from "./pages/admin/Users";
import AuditLog from "./pages/admin/AuditLog";
import Settings from "./pages/admin/Settings";
import DemoReset from "./pages/admin/DemoReset";
import Stations from "./pages/admin/Stations";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/giris" replace />} />
      <Route path="/kiosk/:slug" element={<KioskFlow />} />
      <Route path="/giris" element={<Login />} />
      <Route path="/sifremi-unuttum" element={<ForgotPassword />} />
      <Route path="/sifre-sifirla" element={<ResetPassword />} />
      <Route path="/yetkisiz" element={<Unauthorized />} />

      <Route element={<RequireRole roles={["admin", "operator", "viewer"]} />}>
        <Route element={<AppLayout />}>
          <Route path="/operator" element={<Dashboard />} />
          <Route path="/operator/pompalar" element={<Pumps />} />
          <Route path="/operator/islemler" element={<Transactions />} />
          <Route path="/operator/alarmlar" element={<Alarms />} />
          <Route path="/operator/harita" element={<StationMap />} />
          <Route path="/operator/raporlar" element={<Reports />} />
          {/* Vardiya sistemi gecici olarak devre disi - bkz. yukaridaki import. */}
          {/* <Route path="/operator/vardiya" element={<Shift />} /> */}
          <Route path="/operator/sifre-degistir" element={<ChangePassword />} />

          <Route element={<RequireRole roles={["admin"]} />}>
            <Route path="/admin" element={<Navigate to="/admin/kullanicilar" replace />} />
            <Route path="/admin/kullanicilar" element={<Users />} />
            <Route path="/admin/ayarlar" element={<Settings />} />
            <Route path="/operator/stok" element={<FuelStock />} />
            <Route path="/admin/kampanyalar" element={<DiscountCodes />} />
            <Route path="/admin/sadakat-puanlari" element={<LoyaltyLookup />} />
          </Route>

          <Route element={<RequireRole roles={["super_admin"]} />}>
            <Route path="/admin/istasyonlar" element={<Stations />} />
            <Route path="/admin/audit-log" element={<AuditLog />} />
            <Route path="/admin/sifirla" element={<DemoReset />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/giris" replace />} />
    </Routes>
  );
}
