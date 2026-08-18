import { useEffect, useState } from "react";
import { api } from "./api";
import { useTopicSubscription } from "./useWebSocket";
import { useEffectiveStationId } from "./useEffectiveStation";
import type { Alarm, Pump } from "./types";

export function usePumps() {
  const stationId = useEffectiveStationId();
  const [pumps, setPumps] = useState<Pump[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (stationId === null) return;
    setLoading(true);
    api.get<{ pumps: Pump[] }>("/api/pumps").then((res) => {
      setPumps(res.pumps);
      setLoading(false);
    });
  }, [stationId]);

  useTopicSubscription(stationId !== null ? `pumps:${stationId}` : null, (payload) => setPumps(payload as Pump[]));

  return { pumps, loading, setPumps };
}

export function useActiveAlarms() {
  const stationId = useEffectiveStationId();
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (stationId === null) return;
    setLoading(true);
    api.get<{ alarms: Alarm[] }>("/api/alarms?status=active").then((res) => {
      setAlarms(res.alarms);
      setLoading(false);
    });
  }, [stationId]);

  useTopicSubscription(stationId !== null ? `alarms:${stationId}` : null, (payload) => setAlarms(payload as Alarm[]));

  return { alarms, loading };
}
