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
import ChangePassword from "./pages/operator/account/ChangePassword";
import TwoFactor from "./pages/operator/account/TwoFactor";
import Sessions from "./pages/operator/account/Sessions";
import NotificationSettings from "./pages/operator/account/NotificationSettings";
import Shift from "./pages/operator/Shift";
import FuelStock from "./pages/operator/FuelStock";
import FuelVariance from "./pages/operator/FuelVariance";
import Reconciliation from "./pages/operator/Reconciliation";
import SupportRequests from "./pages/operator/SupportRequests";
import DiscountCodes from "./pages/admin/DiscountCodes";
import FleetAccounts from "./pages/admin/FleetAccounts";
import LoyaltyLookup from "./pages/admin/LoyaltyLookup";
import KvkkRequests from "./pages/admin/KvkkRequests";
import Users from "./pages/admin/Users";
import AuditLog from "./pages/admin/AuditLog";
import FuelPrices from "./pages/admin/settings/FuelPrices";
import PaymentSettings from "./pages/admin/settings/PaymentSettings";
import LoyaltySettings from "./pages/admin/settings/LoyaltySettings";
import InvoiceSettings from "./pages/admin/settings/InvoiceSettings";
import ReportEmailSettings from "./pages/admin/settings/ReportEmailSettings";
import StationAgentSettings from "./pages/admin/settings/StationAgentSettings";
import DemoReset from "./pages/admin/DemoReset";
import Stations from "./pages/admin/Stations";
import KioskFleet from "./pages/admin/KioskFleet";
import Tenants from "./pages/admin/Tenants";
import Portfolio from "./pages/admin/Portfolio";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/giris" replace />} />
      <Route path="/kiosk/:slug" element={<KioskFlow />} />
      <Route path="/giris" element={<Login />} />
      <Route path="/sifremi-unuttum" element={<ForgotPassword />} />
      <Route path="/sifre-sifirla" element={<ResetPassword />} />
      <Route path="/yetkisiz" element={<Unauthorized />} />

      <Route element={<RequireRole roles={["tenant_admin", "admin", "operator", "viewer"]} />}>
        <Route element={<AppLayout />}>
          <Route path="/operator" element={<Dashboard />} />
          <Route path="/operator/pompalar" element={<Pumps />} />
          <Route path="/operator/islemler" element={<Transactions />} />
          <Route path="/operator/alarmlar" element={<Alarms />} />
          <Route path="/operator/harita" element={<StationMap />} />
          <Route path="/operator/raporlar" element={<Reports />} />
          <Route path="/operator/vardiya" element={<Shift />} />

          {/* Hesap sayfalari - sidebar'in en altindaki hesap kartinin acilir menusunden ulasilir. */}
          <Route path="/operator/hesabim" element={<Navigate to="/operator/hesabim/sifre" replace />} />
          <Route path="/operator/hesabim/sifre" element={<ChangePassword />} />
          <Route path="/operator/hesabim/iki-adimli-dogrulama" element={<TwoFactor />} />
          <Route path="/operator/hesabim/oturumlar" element={<Sessions />} />
          <Route path="/operator/hesabim/bildirimler" element={<NotificationSettings />} />
          {/* Eski tekil adres - zorunlu sifre degistirme uyarisi (ChangePasswordBanner) buraya isaret ediyordu. */}
          <Route path="/operator/sifre-degistir" element={<Navigate to="/operator/hesabim/sifre" replace />} />

          <Route element={<RequireRole roles={["tenant_admin", "admin"]} />}>
            <Route path="/admin" element={<Navigate to="/admin/kullanicilar" replace />} />
            <Route path="/admin/kullanicilar" element={<Users />} />
            {/* Ayar sayfalari - sidebar'daki "Ayarlar" acilir menusunden ulasilir. */}
            <Route path="/admin/ayarlar" element={<Navigate to="/admin/ayarlar/yakit-fiyatlari" replace />} />
            <Route path="/admin/ayarlar/yakit-fiyatlari" element={<FuelPrices />} />
            <Route path="/admin/ayarlar/odeme" element={<PaymentSettings />} />
            <Route path="/admin/ayarlar/sadakat" element={<LoyaltySettings />} />
            <Route path="/admin/ayarlar/fatura" element={<InvoiceSettings />} />
            <Route path="/admin/ayarlar/ozet-raporu" element={<ReportEmailSettings />} />
            <Route path="/admin/ayarlar/istasyon-ajani" element={<StationAgentSettings />} />
            <Route path="/operator/stok" element={<FuelStock />} />
            <Route path="/operator/sapma" element={<FuelVariance />} />
            <Route path="/operator/mutabakat" element={<Reconciliation />} />
            <Route path="/operator/destek" element={<SupportRequests />} />
            <Route path="/admin/kampanyalar" element={<DiscountCodes />} />
            <Route path="/admin/filo-hesaplari" element={<FleetAccounts />} />
            <Route path="/admin/sadakat-puanlari" element={<LoyaltyLookup />} />
            <Route path="/admin/kvkk" element={<KvkkRequests />} />
          </Route>

          {/* Dagitim sirketi yoneticisi de kendi istasyonlarini ve kiosk'larini gorur;
              hangi kayitlarin dondugunu sunucu belirler (bkz. middleware/tenantScope.ts).
              Dagitim sirketi tanimlamak ise ticari bir karardir, platforma ozeldir. */}
          <Route element={<RequireRole roles={["tenant_admin"]} />}>
            <Route path="/admin/istasyonlar" element={<Stations />} />
            <Route path="/admin/kiosk-filosu" element={<KioskFleet />} />
            <Route path="/admin/konsolide-rapor" element={<Portfolio />} />
          </Route>

          <Route element={<RequireRole roles={["super_admin"]} />}>
            <Route path="/admin/dagitim-sirketleri" element={<Tenants />} />
            <Route path="/admin/konsolide-rapor" element={<Portfolio />} />
            <Route path="/admin/audit-log" element={<AuditLog />} />
            <Route path="/admin/sifirla" element={<DemoReset />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/giris" replace />} />
    </Routes>
  );
}
