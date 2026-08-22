import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./AuthContext";
import { useCurrentStationId } from "./useCurrentStation";
import { initials } from "./format";
import type { Station } from "./types";

/**
 * Sidebar'in en ustundeki "istasyon karti". super_admin icin gercek bir acilir
 * menu (istasyonlar arasi gecis, StationSwitcher'in eski <select> islevinin
 * yerini alir); diger roller icin kendi istasyonlarinin adini (bkz. auth.ts /me
 * -> stationName) sadece goruntuleyen, tiklanamayan sabit bir kart.
 */
export default function StationSwitcher() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useCurrentStationId();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get<{ stations: Station[] }>("/api/stations").then((res) => {
      setStations(res.stations);
      if (stationId === null && res.stations.length > 0) {
        setStationId(res.stations[0]!.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  if (isSuperAdmin && stations.length === 0) {
    return (
      <div className="sidebar-org-card">
        <Link to="/admin/istasyonlar">
          <button className="ghost" style={{ width: "100%" }}>İlk istasyonu oluştur</button>
        </Link>
      </div>
    );
  }

  const currentName = isSuperAdmin
    ? stations.find((s) => s.id === stationId)?.name ?? "İstasyon seçin"
    : user.stationName ?? "Yakıt İstasyonu";

  return (
    <div className="sidebar-org-card" ref={boxRef}>
      <button
        type="button"
        className="sidebar-card-trigger"
        onClick={() => isSuperAdmin && setOpen((v) => !v)}
        style={{ cursor: isSuperAdmin ? "pointer" : "default" }}
      >
        <span className="sidebar-avatar">{initials(currentName)}</span>
        <span className="sidebar-card-text">
          <strong>{currentName}</strong>
          <span className="hint-text">{isSuperAdmin ? "İstasyon değiştir" : "İstasyon"}</span>
        </span>
        {isSuperAdmin && <span className={`sidebar-chevron${open ? " open" : ""}`}>▾</span>}
      </button>
      {isSuperAdmin && open && (
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
