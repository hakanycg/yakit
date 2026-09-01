import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "wheel"] as const;

/**
 * Belirtilen sürede hiçbir kullanıcı etkileşimi olmazsa `onIdle` çağrılır.
 *
 * `capture: true` ile dinleniyor: `scroll` gibi olaylar `window`'a kabarmaz,
 * yalnizca ic ice bir tablo/panel kaydirilsa bile hareketsizlik sayacinin
 * sifirlanmasi gerekir.
 */
export function useIdleLogout(timeoutMs: number, onIdle: () => void): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    function reset() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onIdleRef.current(), timeoutMs);
    }

    reset();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, reset, { passive: true, capture: true });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, reset, { capture: true });
    };
  }, [timeoutMs]);
}
