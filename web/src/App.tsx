import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import KioskFlow from "./kiosk/KioskFlow";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Unauthorized from "./pages/Unauthorized";
import AppLayout from "./shared/AppLayout";
import { RequireRole } from "./shared/RequireRole";

/**
 * Kiosk disindaki her sayfa TALEP UZERINE yuklenir.
 *
 * Kiosk tek parca halinde yonetim panelinin tamamini indiriyordu: musteri ekranina hic
 * girmeyecegi 30 kusur sayfanin kodu, istasyonun zayif hattindan her acilista tekrar
 * geciyordu. Kiosk (KioskFlow), kabuk (AppLayout/RequireRole) ve giris akisi eager
 * kalir - ilki hizli acilmali, digerleri zaten her panel sayfasinda gerekli.
 */
const FleetPortal = lazy(() => import("./fleet/FleetPortal"));
const Dashboard = lazy(() => import("./pages/operator/Dashboard"));
const Pumps = lazy(() => import("./pages/operator/Pumps"));
const Transactions = lazy(() => import("./pages/operator/Transactions"));
const Alarms = lazy(() => import("./pages/operator/Alarms"));
const StationMap = lazy(() => import("./pages/operator/StationMap"));
const Reports = lazy(() => import("./pages/operator/Reports"));
const ChangePassword = lazy(() => import("./pages/operator/account/ChangePassword"));
const TwoFactor = lazy(() => import("./pages/operator/account/TwoFactor"));
const Sessions = lazy(() => import("./pages/operator/account/Sessions"));
const NotificationSettings = lazy(() => import("./pages/operator/account/NotificationSettings"));
const Shift = lazy(() => import("./pages/operator/Shift"));
const FuelStock = lazy(() => import("./pages/operator/FuelStock"));
const FuelVariance = lazy(() => import("./pages/operator/FuelVariance"));
const PumpTotalizers = lazy(() => import("./pages/operator/PumpTotalizers"));
const Reconciliation = lazy(() => import("./pages/operator/Reconciliation"));
const SupportRequests = lazy(() => import("./pages/operator/SupportRequests"));
const DiscountCodes = lazy(() => import("./pages/admin/DiscountCodes"));
const FleetAccounts = lazy(() => import("./pages/admin/FleetAccounts"));
const FleetReceivables = lazy(() => import("./pages/admin/FleetReceivables"));
const LoyaltyLookup = lazy(() => import("./pages/admin/LoyaltyLookup"));
const KvkkRequests = lazy(() => import("./pages/admin/KvkkRequests"));
const Users = lazy(() => import("./pages/admin/Users"));
const AuditLog = lazy(() => import("./pages/admin/AuditLog"));
const SystemErrors = lazy(() => import("./pages/admin/SystemErrors"));
const FuelPrices = lazy(() => import("./pages/admin/settings/FuelPrices"));
const PaymentSettings = lazy(() => import("./pages/admin/settings/PaymentSettings"));
const WebhookSettings = lazy(() => import("./pages/admin/settings/WebhookSettings"));
const LoyaltySettings = lazy(() => import("./pages/admin/settings/LoyaltySettings"));
const InvoiceSettings = lazy(() => import("./pages/admin/settings/InvoiceSettings"));
const ReportEmailSettings = lazy(() => import("./pages/admin/settings/ReportEmailSettings"));
const StationAgentSettings = lazy(() => import("./pages/admin/settings/StationAgentSettings"));
const Stations = lazy(() => import("./pages/admin/Stations"));
const KioskFleet = lazy(() => import("./pages/admin/KioskFleet"));
const Tenants = lazy(() => import("./pages/admin/Tenants"));
const Portfolio = lazy(() => import("./pages/admin/Portfolio"));

export default function App() {
  return (
    // Sayfa gecerken kisa bir bekleme gorunur; kiosk bu sarmalayicinin icinde DEGIL
    // gibi davranir cunku KioskFlow eager yuklenmistir - ilk boyada askiya dusmez.
    <Suspense fallback={<div className="login-shell" />}>
      <Routes>
        <Route path="/" element={<Navigate to="/giris" replace />} />
        <Route path="/kiosk/:slug" element={<KioskFlow />} />
        {/* Filo musteri portali: personel oturumundan tamamen ayri bir kimlikle calisir
            (bkz. fleet/FleetPortal.tsx), bu yuzden RequireRole/AppLayout disindadir. */}
        <Route path="/filo" element={<FleetPortal />} />
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
            <Route path="/operator/vardiya" element={<Shift />} />
            {/* Destek talepleri sahada calisan kisinin isi: musteri pompada takildiginda
                ona ilk ulasan operatordur. */}
            <Route path="/operator/destek" element={<SupportRequests />} />

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
              <Route path="/admin/ayarlar/webhook" element={<WebhookSettings />} />
              <Route path="/admin/ayarlar/sadakat" element={<LoyaltySettings />} />
              <Route path="/admin/ayarlar/fatura" element={<InvoiceSettings />} />
              <Route path="/admin/ayarlar/ozet-raporu" element={<ReportEmailSettings />} />
              <Route path="/admin/ayarlar/istasyon-ajani" element={<StationAgentSettings />} />
              <Route path="/operator/stok" element={<FuelStock />} />
              <Route path="/operator/sapma" element={<FuelVariance />} />
            <Route path="/operator/pompa-sayaclari" element={<PumpTotalizers />} />
              <Route path="/operator/mutabakat" element={<Reconciliation />} />
              {/* Ciro/kar raporlari istasyon sahibinindir (bkz. server/src/routes/reports.ts). */}
              <Route path="/operator/raporlar" element={<Reports />} />
              <Route path="/admin/kampanyalar" element={<DiscountCodes />} />
              <Route path="/admin/filo-hesaplari" element={<FleetAccounts />} />
              <Route path="/admin/filo-alacaklari" element={<FleetReceivables />} />
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
              <Route path="/admin/sunucu-hatalari" element={<SystemErrors />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/giris" replace />} />
      </Routes>
    </Suspense>
  );
}
