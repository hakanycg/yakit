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
 * SUNUCU belirler: /api/stations, tenant_admin'e yalnizca kendi kiracisinin
 * istasyonlarini doner (bkz. routes/stations.ts). Istemcinin filtrelemesine
 * guvenilmez - izolasyon sunucuda zorlanir.
 *
 * Diger roller icin kendi istasyonlarinin adini (bkz. auth.ts /me -> stationName)
 * sadece goruntuleyen, tiklanamayan sabit bir kart.
 */
export default function StationSwitcher() {
  const { user } = useAuth();
  const canSwitch = user?.role === "super_admin" || user?.role === "tenant_admin";
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useCurrentStationId();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canSwitch) return;
    api.get<{ stations: Station[] }>("/api/stations").then((res) => {
      setStations(res.stations);
      if (stationId === null && res.stations.length > 0) {
        setStationId(res.stations[0]!.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSwitch]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  if (user.role === "super_admin" && stations.length === 0) {
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
  if (user.role === "tenant_admin" && stations.length === 0) {
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

  const currentName = canSwitch
    ? stations.find((s) => s.id === stationId)?.name ?? "İstasyon seçin"
    : user.stationName ?? "Yakıt İstasyonu";

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
          {stations.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sidebar-dropdown-item${s.id === stationId ? " active" : ""}`}
              onClick={() => {
                setStationId(s.id);
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
