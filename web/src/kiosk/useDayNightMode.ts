import { useEffect, useState } from "react";

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;

function currentMode(): "day" | "night" {
  const hour = new Date().getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? "day" : "night";
}

/**
 * Kiosk ekranı genelde günlerce hiç yenilenmeden aynı sekmede açık kalır (bkz.
 * KioskFlow.tsx), bu yüzden gündüz/gece görünümü sayfa yüklenirken bir kere
 * hesaplanıp sabit kalamaz - saat DAY_END_HOUR'u geçtiği an ekran otomatik
 * karanlık moda dönmeli. Dakikada bir kontrol, saniyede bir kontrolden
 * gereksiz yeniden render'ı önler; bu geçiş saniyesi hassasiyeti gerektirmeyen
 * kozmetik bir değişimdir.
 */
export function useDayNightMode(): "day" | "night" {
  const [mode, setMode] = useState<"day" | "night">(currentMode);

  useEffect(() => {
    const interval = setInterval(() => {
      setMode((prev) => {
        const next = currentMode();
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  return mode;
}
