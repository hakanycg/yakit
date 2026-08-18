import { useEffect, useState } from "react";
import { api } from "./api";
import { useTopicSubscription } from "./useWebSocket";
import type { Alarm, Pump } from "./types";

export function usePumps() {
  const [pumps, setPumps] = useState<Pump[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ pumps: Pump[] }>("/api/pumps").then((res) => {
      setPumps(res.pumps);
      setLoading(false);
    });
  }, []);

  useTopicSubscription("pumps", (payload) => setPumps(payload as Pump[]));

  return { pumps, loading, setPumps };
}

export function useActiveAlarms() {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ alarms: Alarm[] }>("/api/alarms?status=active").then((res) => {
      setAlarms(res.alarms);
      setLoading(false);
    });
  }, []);

  useTopicSubscription("alarms", (payload) => setAlarms(payload as Alarm[]));

  return { alarms, loading };
}
