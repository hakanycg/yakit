import { useEffect, useRef, useState } from "react";
import { useActiveAlarms } from "./hooks";

type PermissionState = "default" | "granted" | "denied";

export function useBrowserNotificationPermission(): {
  permission: PermissionState;
  requestPermission: () => void;
  supported: boolean;
} {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<PermissionState>(supported ? (Notification.permission as PermissionState) : "denied");

  function requestPermission() {
    if (!supported) return;
    Notification.requestPermission().then((p) => setPermission(p as PermissionState));
  }

  return { permission, requestPermission, supported };
}

/** Panel acikken yeni kritik alarm geldiginde tarayici bildirimi gosterir (izin verilmisse). Uygulamada bir kez, ust seviyede cagrilmalidir. */
export function useCriticalAlarmNotifications(): void {
  const { alarms } = useActiveAlarms();
  const seenIds = useRef<Set<number> | null>(null);

  useEffect(() => {
    const supported = typeof window !== "undefined" && "Notification" in window;
    if (!supported) return;

    // Ilk yuklemede mevcut alarmlari "gorulmus" say; sadece bundan sonra gelenler icin bildirim goster.
    if (seenIds.current === null) {
      seenIds.current = new Set(alarms.map((a) => a.id));
      return;
    }

    if (Notification.permission !== "granted") {
      seenIds.current = new Set(alarms.map((a) => a.id));
      return;
    }

    for (const alarm of alarms) {
      if (alarm.severity === "critical" && !seenIds.current.has(alarm.id)) {
        try {
          new Notification("Kritik Alarm", { body: alarm.message, tag: `alarm-${alarm.id}` });
        } catch {
          // bazi tarayicilarda (orn. izin verilmemis sekmeler) hata olusabilir, sessizce yoksay
        }
      }
    }
    seenIds.current = new Set(alarms.map((a) => a.id));
  }, [alarms]);
}
