import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useCurrentStationId } from "./useCurrentStation";
import type { Station } from "./types";

export default function StationSwitcher() {
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useCurrentStationId();

  useEffect(() => {
    api.get<{ stations: Station[] }>("/api/stations").then((res) => {
      setStations(res.stations);
      if (stationId === null && res.stations.length > 0) {
        setStationId(res.stations[0]!.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (stations.length === 0) {
    return (
      <Link to="/admin/istasyonlar">
        <button className="ghost">İlk istasyonu oluştur</button>
      </Link>
    );
  }

  return (
    <select value={stationId ?? ""} onChange={(e) => setStationId(Number(e.target.value))} style={{ maxWidth: 220 }}>
      {stations.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  );
}
