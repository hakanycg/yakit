import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./AuthContext";
import { useCurrentStationId } from "./useCurrentStation";
import { initials } from "./format";
import type { Station } from "./types";

/**
 * Sidebar'in en ustundeki "istasyon karti".
 *
 * SABIT bir gostergedir - tiklanip acilir bir menu DEGILDIR: hangi istasyonun
 * verisi gosteriliyorsa o, kazayla degistirilemesin diye. Istasyonlar arasi
 * gecis yalnizca Istasyonlar sayfasindaki (bkz. Stations.tsx) "Bu istasyona
 * geç" butonuyla, bilinçli bir eylemle yapilir.
 *
 * super_admin/tenant_admin icin ilk girişte (henüz hiç istasyon seçilmemişse)
 * ilk istasyon SESSIZCE otomatik secilir - aksi halde bir istasyon secilene
 * kadar `requireStationSelected` gerektiren hiçbir sayfa çalışmazdı. Bu, bir
 * kullanıcı EYLEMİ değil, yalnızca bir varsayılan atamadır.
 *
 * Diger roller icin kendi istasyonlarinin adini (bkz. auth.ts /me -> stationName)
 * goruntuleyen, zaten sabit bir kart.
 */
export default function StationSwitcher() {
  const { user } = useAuth();
  const canSwitch = user?.role === "super_admin" || user?.role === "tenant_admin";
  const [currentStation, setCurrentStation] = useState<Station | null>(null);
  const [hasAnyStation, setHasAnyStation] = useState(true);
  const [stationId, setStationId] = useCurrentStationId();

  useEffect(() => {
    if (!canSwitch) return;
    if (stationId !== null) {
      api
        .get<{ station: Station }>("/api/stations/current")
        .then((res) => setCurrentStation(res.station))
        .catch(() => setCurrentStation(null));
      return;
    }
    // Henuz hic istasyon secilmemis (ilk giris) - sessizce ilk istasyona baglanir.
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
        <div className="sidebar-card-trigger" style={{ cursor: "default" }}>
          <span className="sidebar-avatar">{initials(user.tenantName ?? "?")}</span>
          <span className="sidebar-card-text">
            <strong>{user.tenantName ?? "Dağıtım Şirketi"}</strong>
          </span>
        </div>
        <p className="hint-text" style={{ margin: "0.4rem 0 0" }}>Henüz istasyon atanmamış.</p>
      </div>
    );
  }

  const currentName = canSwitch ? currentStation?.name ?? "…" : user.stationName ?? "Yakıt İstasyonu";

  return (
    <div className="sidebar-org-card">
      <div className="sidebar-card-trigger" style={{ cursor: "default" }}>
        <span className="sidebar-avatar">{initials(currentName)}</span>
        <span className="sidebar-card-text">
          <strong>{currentName}</strong>
        </span>
      </div>
    </div>
  );
}
