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
  tenant_admin: "Dağıtım Şirketi Yöneticisi",
  admin: "İstasyon Yöneticisi",
  operator: "Operator",
  viewer: "İzleyici",
};

/**
 * Sidebar menu gruplari.
 *
 * Once bolumler duz listelerdi: bir istasyon yoneticisi tek sutunda 20'ye yakin link
 * goruyordu ve aralarinda hicbir hiyerarsi yoktu - aranan sayfa her seferinde
 * bastan taranarak bulunuyordu. Ayni ise ait sayfalar artik "Ayarlar"da oldugu
 * gibi acilir gruplar halinde. Gruplama yalnizca GORUNUM icindir; hangi rolun
 * neyi gorecegi asagidaki kosullarla, erisim izolasyonu ise sunucuda belirlenir
 * (bkz. middleware/tenantScope.ts).
 */
const SETTINGS_PAGES = [
  { to: "/admin/ayarlar/yakit-fiyatlari", label: "Yakıt Fiyatları" },
  { to: "/admin/ayarlar/odeme", label: "Ödeme (iyzico)" },
  { to: "/admin/ayarlar/webhook", label: "Webhook Bildirimi" },
  { to: "/admin/ayarlar/sadakat", label: "Sadakat / Puan" },
  { to: "/admin/ayarlar/fatura", label: "Fatura / İrsaliye" },
  { to: "/admin/ayarlar/ozet-raporu", label: "Otomatik Özet Raporu" },
  { to: "/admin/ayarlar/istasyon-ajani", label: "İstasyon Ajanı" },
];

/** Sahadaki durumu izleyen sayfalar. */
const FIELD_PAGES = [
  { to: "/operator/harita", label: "İstasyon Haritası" },
  { to: "/operator/vardiya", label: "Vardiya" },
  { to: "/operator/destek", label: "Destek Talepleri" },
];

/** Akaryakitin fiziksel takibi: ne kadar var, ne kadari kayip. */
const FUEL_PAGES = [
  { to: "/operator/stok", label: "Yakıt Stoku" },
  { to: "/operator/sapma", label: "Yakıt Sapma" },
  { to: "/operator/pompa-sayaclari", label: "Pompa Sayaçları" },
];

/** Musteriye donuk programlar: kampanya, filo sozlesmesi, puan. */
const CUSTOMER_PAGES = [
  { to: "/admin/kampanyalar", label: "Kampanyalar" },
  { to: "/admin/filo-hesaplari", label: "Filo Hesapları" },
  { to: "/admin/filo-alacaklari", label: "Filo Alacakları" },
  { to: "/admin/sadakat-puanlari", label: "Sadakat Puanları" },
];

/** Kim neye erisiyor, kisisel veri nasil yonetiliyor. */
const COMPLIANCE_PAGES = [
  { to: "/admin/kullanicilar", label: "Kullanıcı / Rol Yönetimi" },
  { to: "/admin/kvkk", label: "KVKK Başvuruları" },
];

/** Platform yoneticisinin kurulus kayitlari. */
const ORG_PAGES = [
  { to: "/admin/dagitim-sirketleri", label: "Dağıtım Şirketleri" },
  { to: "/admin/istasyonlar", label: "İstasyonlar" },
];

/** Platform yoneticisinin sistem araclari. */
const SYSTEM_PAGES = [
  { to: "/admin/audit-log", label: "Audit Log" },
  { to: "/admin/sunucu-hatalari", label: "Sunucu Hataları" },
];

/**
 * Sidebar'da tek bir link yerine, tiklaninca alt sayfalarini acan menu basligi.
 *
 * TUM gruplar KAPALI baslar - bulundugunuz sayfayi icereni de dahil. Acik baslamak
 * menuyu her sayfada farkli yukseklikte gosteriyor, alttaki gruplarin yeri kayiyordu;
 * kapali menu her zaman ayni, kisa ve okunur. Bulundugunuz grup yine de baslikta
 * vurgulanir (containsActive), yani kapaliyken de nerede oldugunuzu gorursunuz.
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

  const closeMenu = () => setMenuOpen(false);

  if (!user) return null;

  const isSuperAdmin = user.role === "super_admin";
  const isTenantAdmin = user.role === "tenant_admin";
  const isStationAdmin = user.role === "admin" || isSuperAdmin || isTenantAdmin;

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-overlay" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <StationSwitcher />
        <nav onClick={() => setMenuOpen(false)}>
          {isSuperAdmin && (
            <>
              <p className="section-label">Platform</p>
              <NavLink to="/admin/konsolide-rapor">Konsolide Rapor</NavLink>
              <NavLink to="/admin/kiosk-filosu">Kiosk Filosu</NavLink>
              <SidebarSubmenu label="Kuruluşlar" pages={ORG_PAGES} onNavigate={closeMenu} />
              <SidebarSubmenu label="Sistem" pages={SYSTEM_PAGES} onNavigate={closeMenu} />
            </>
          )}

          {/* Dagitim sirketi yoneticisi: kendi istasyonlarini ve kiosk'larini gorur.
              Menude ne gorundugu kolaylik icindir; erisim izolasyonu sunucuda zorlanir
              (bkz. middleware/tenantScope.ts). */}
          {isTenantAdmin && (
            <>
              <p className="section-label">Dağıtım Şirketi</p>
              <NavLink to="/admin/konsolide-rapor">Konsolide Rapor</NavLink>
              <NavLink to="/admin/istasyonlar">İstasyonlarım</NavLink>
              <NavLink to="/admin/kiosk-filosu">Kiosk Filosu</NavLink>
            </>
          )}

          <p className="section-label">Günlük İşleyiş</p>
          <NavLink to="/operator" end>Genel Bakış</NavLink>
          <NavLink to="/operator/pompalar">Pompalar</NavLink>
          <NavLink to="/operator/islemler">İşlem Listesi</NavLink>
          {/* Alarm Merkezi bilerek grup icine alinmadi: yangin/gaz alarmi bir tik
              arkasinda durmamali. */}
          <NavLink to="/operator/alarmlar">Alarm Merkezi</NavLink>
          <SidebarSubmenu label="Saha" pages={FIELD_PAGES} onNavigate={closeMenu} />

          {isStationAdmin && (
            <>
              <p className="section-label">İstasyon Yönetimi</p>
              {/* Ciro/kar raporlari operatorde degil, isletmede: sunucu da bu ayrimi
                  uyguluyor (bkz. server/src/routes/reports.ts). */}
              <NavLink to="/operator/raporlar">Raporlama</NavLink>
              <NavLink to="/operator/mutabakat">Gün Sonu Mutabakatı</NavLink>
              <SidebarSubmenu label="Akaryakıt" pages={FUEL_PAGES} onNavigate={closeMenu} />
              <SidebarSubmenu label="Müşteri" pages={CUSTOMER_PAGES} onNavigate={closeMenu} />
              <SidebarSubmenu label="Yetki ve Uyum" pages={COMPLIANCE_PAGES} onNavigate={closeMenu} />
              <SidebarSubmenu label="Ayarlar" pages={SETTINGS_PAGES} onNavigate={closeMenu} />
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
