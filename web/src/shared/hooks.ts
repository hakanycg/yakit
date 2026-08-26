import { useEffect, useState } from "react";
import { api } from "./api";
import { useTopicSubscription } from "./useWebSocket";
import { useEffectiveStationId } from "./useEffectiveStation";
import type { Alarm, Pump, Transaction } from "./types";

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

  /**
   * Pompa yayini yalnizca DURUM degistiginde tetiklenir (bkz. pumpService.broadcastPumps);
   * dolum surerken akan litre/tutar oradan gelmez. Islem yayinini da dinleyip pompanin
   * uzerindeki canli satisi guncelliyoruz - aksi halde harita, dolum boyunca ilk
   * andaki (sifir) tutari gosterip kalirdi.
   */
  useTopicSubscription(stationId !== null ? `transactions:${stationId}` : null, (payload) => {
    const t = payload as Transaction;
    setPumps((prev) =>
      prev.map((p) => {
        if (p.currentTransactionId !== t.id) return p;
        const closed = t.status === "completed" || t.status === "cancelled" || t.status === "failed";
        return {
          ...p,
          activeSale: closed
            ? null
            : {
                transactionId: t.id,
                plate: t.plate,
                fuelType: t.fuelType,
                liters: t.dispensedLiters,
                amount: t.chargeAmount,
              },
        };
      })
    );
  });

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
