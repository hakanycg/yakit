import { useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "touchstart", "keydown"] as const;

/**
 * Karsilama ekraninda uzun sure (varsayilan 20sn) hicbir etkilesim olmazsa "dikkat
 * cekme" modunu (AttractMode) tetikler - gecmekte olan bir musteriye guncel yakit
 * fiyatlarini/kampanyalari gostermek icin. Herhangi bir gercek etkilesim (dokunma/
 * tiklama/tus) modu aninda kapatir - useIdleReset ile ayni desen, ama uyari/geri
 * sayim olmadan, sadece boolean bir "attracting" durumu doner.
 */
export function useAttractMode(enabled: boolean, delayMs = 20_000): boolean {
  const [attracting, setAttracting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function reset() {
      if (timer.current) clearTimeout(timer.current);
      setAttracting(false);
      timer.current = setTimeout(() => setAttracting(true), delayMs);
    }

    if (!enabled) {
      if (timer.current) clearTimeout(timer.current);
      setAttracting(false);
      return;
    }

    reset();
    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, reset);
    return () => {
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, delayMs]);

  return attracting;
}
