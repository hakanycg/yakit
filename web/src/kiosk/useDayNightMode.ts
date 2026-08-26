import { useEffect, useState } from "react";
import { isDaylight } from "./sunTimes";

/**
 * Konum bilinmiyorken kullanilan yedek saatler. Istasyonun enlem/boylami girilmemisse
 * ya da kutup bolgesi gibi gun dogumu tanimsiz bir yerdeyse buraya dusulur.
 */
const FALLBACK_DAY_START_HOUR = 7;
const FALLBACK_DAY_END_HOUR = 19;

export interface StationCoords {
  latitude: number | null;
  longitude: number | null;
}

function currentMode(coords: StationCoords | null): "day" | "night" {
  if (coords && coords.latitude !== null && coords.longitude !== null) {
    const daylight = isDaylight(Date.now(), coords.latitude, coords.longitude);
    if (daylight !== null) return daylight ? "day" : "night";
  }
  const hour = new Date().getHours();
  return hour >= FALLBACK_DAY_START_HOUR && hour < FALLBACK_DAY_END_HOUR ? "day" : "night";
}

/**
 * Kiosk ekrani genelde gunlerce hic yenilenmeden ayni sekmede acik kalir (bkz.
 * KioskFlow.tsx), bu yuzden gunduz/gece gorunumu sayfa yuklenirken bir kere
 * hesaplanip sabit kalamaz - hava karardigi an ekran otomatik koyu moda donmeli.
 * Dakikada bir kontrol, saniyede bir kontrolden gereksiz yeniden render'i onler;
 * bu gecis saniye hassasiyeti gerektirmeyen kozmetik bir degisimdir.
 *
 * Gecis ani sabit bir saat DEGIL, istasyonun kendi konumundaki alacakaranliktir
 * (bkz. sunTimes.ts): Antalya ile Erzurum ayni anda kararmaz ve mevsim kendiliginden
 * takip edilir - kurulumda girilecek ya da mevsimlik guncellenecek bir ayar yok.
 */
export function useDayNightMode(coords: StationCoords | null): "day" | "night" {
  const latitude = coords?.latitude ?? null;
  const longitude = coords?.longitude ?? null;
  const [mode, setMode] = useState<"day" | "night">(() => currentMode(coords));

  useEffect(() => {
    // Konum istasyon yuklenince geldigi icin ilk deger saat tabanli yedekle
    // hesaplanmis olabilir; koordinat elde edilir edilmez yeniden degerlendir.
    const evaluate = () => {
      const next = currentMode({ latitude, longitude });
      setMode((prev) => (next === prev ? prev : next));
    };
    evaluate();
    const interval = setInterval(evaluate, 60_000);
    return () => clearInterval(interval);
  }, [latitude, longitude]);

  return mode;
}
