import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./AuthContext";
import { useCurrentStationId } from "./useCurrentStation";
import { initials } from "./format";
import type { Station } from "./types";

/**
 * Sidebar'in en ustundeki "istasyon karti".
 *
 * super_admin ve tenant_admin icin gercek bir acilir menu (istasyonlar arasi gecis);
 * ikisinin de sabit bir istasyonu yoktur. Aradaki fark listenin icerigidir ve bunu
 * SUNUCU belirler: /api/stations/search, tenant_admin'e yalnizca kendi kiracisinin
 * istasyonlarini doner (bkz. routes/stations.ts). Istemcinin filtrelemesine
 * guvenilmez - izolasyon sunucuda zorlanir.
 *
 * Binlerce istasyon olabilecegi icin (bkz. Stations.tsx'teki ayni gerekce) TUM
 * liste onceden CEKILMEZ: acilis aninda su anki secili istasyon /api/stations/current
 * ile (tek satir) getirilir, acilir menu ise yazildikca sunucu taraflı arayan
 * /api/stations/search ile doldurulur (StationCombobox.tsx ile ayni desen).
 *
 * Diger roller icin kendi istasyonlarinin adini (bkz. auth.ts /me -> stationName)
 * sadece goruntuleyen, tiklanamayan sabit bir kart.
 */
export default function StationSwitcher() {
  const { user } = useAuth();
  const canSwitch = user?.role === "super_admin" || user?.role === "tenant_admin";
  const [currentStation, setCurrentStation] = useState<Station | null>(null);
  const [hasAnyStation, setHasAnyStation] = useState(true);
  const [stationId, setStationId] = useCurrentStationId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Station[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Secili bir istasyon zaten varsa adini getirir; hic yoksa (ilk giris) ilk
  // istasyonu bulup otomatik secer - eskiden "tum listenin ilk elemani" ile
  // yapilan bu varsayilan artik arama ucundan TEK bir sonucla yapiliyor.
  useEffect(() => {
    if (!canSwitch) return;
    if (stationId !== null) {
      api
        .get<{ station: Station }>("/api/stations/current")
        .then((res) => setCurrentStation(res.station))
        .catch(() => setCurrentStation(null));
      return;
    }
    api.get<{ stations: Station[] }>("/api/stations/search?limit=1").then((res) => {
      if (res.stations.length > 0) {
        setCurrentStation(res.stations[0]!);
        setStationId(res.stations[0]!.id);
      } else {
        setHasAnyStation(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSwitch, stationId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    inputRef.current?.focus();
    setLoadingResults(true);
    const timer = setTimeout(() => {
      api
        .get<{ stations: Station[] }>(`/api/stations/search?q=${encodeURIComponent(query.trim())}&limit=20`)
        .then((res) => setResults(res.stations))
        .finally(() => setLoadingResults(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  if (user.role === "super_admin" && !hasAnyStation) {
    return (
      <div className="sidebar-org-card">
        <Link to="/admin/istasyonlar">
          <button className="ghost" style={{ width: "100%" }}>İlk istasyonu oluştur</button>
        </Link>
      </div>
    );
  }

  // Kiracisina hic istasyon atanmamis bir dagitim sirketi yoneticisi: "istasyon secin"
  // demek yaniltici olurdu, secilecek bir sey yok.
  if (user.role === "tenant_admin" && !hasAnyStation) {
    return (
      <div className="sidebar-org-card">
        <button type="button" className="sidebar-card-trigger" style={{ cursor: "default" }} disabled>
          <span className="sidebar-avatar">{initials(user.tenantName ?? "?")}</span>
          <span className="sidebar-card-text">
            <strong>{user.tenantName ?? "Dağıtım Şirketi"}</strong>
          </span>
        </button>
        <p className="hint-text" style={{ margin: "0.4rem 0 0" }}>Henüz istasyon atanmamış.</p>
      </div>
    );
  }

  const currentName = canSwitch ? currentStation?.name ?? "İstasyon seçin" : user.stationName ?? "Yakıt İstasyonu";

  return (
    <div className="sidebar-org-card" ref={boxRef}>
      <button
        type="button"
        className="sidebar-card-trigger"
        onClick={() => canSwitch && setOpen((v) => !v)}
        style={{ cursor: canSwitch ? "pointer" : "default" }}
      >
        <span className="sidebar-avatar">{initials(currentName)}</span>
        <span className="sidebar-card-text">
          <strong>{currentName}</strong>
        </span>
        {canSwitch && <span className={`sidebar-chevron${open ? " open" : ""}`}>▾</span>}
      </button>
      {canSwitch && open && (
        <div className="sidebar-dropdown">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="İstasyon ara..."
            style={{ marginBottom: "0.3rem" }}
          />
          {loadingResults && <p className="hint-text" style={{ padding: "0.3rem 0.6rem" }}>Aranıyor...</p>}
          {!loadingResults && results.length === 0 && (
            <p className="hint-text" style={{ padding: "0.3rem 0.6rem" }}>Sonuç bulunamadı.</p>
          )}
          {!loadingResults && results.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sidebar-dropdown-item${s.id === stationId ? " active" : ""}`}
              onClick={() => {
                setStationId(s.id);
                setCurrentStation(s);
                setOpen(false);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
