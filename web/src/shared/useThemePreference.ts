import { useEffect, useState } from "react";

export type ThemeMode = "day" | "night";

const STORAGE_KEY = "yakit-theme-mode";

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "day" || stored === "night") return stored;
  } catch {
    // localStorage erisilemez (ozel gezinme, kisitli tarayici ayari) - varsayilana don.
  }
  return "night";
}

/**
 * Yonetim panelinin acik/koyu tema tercihi, kiosk'un aksine (bkz. useDayNightMode.ts)
 * saate gore OTOMATIK degil - burada bir "kullanici" oldugundan (operator/admin) tercih
 * tamamen ona ait ve tarayicida kalici olarak saklanir. Varsayilan "night": mevcut
 * kullanicilarin bugune kadar gordugu koyu tema, hicbir secim yapmadan aynen kalir.
 */
export function useThemePreference(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    document.documentElement.dataset.themeMode = mode;
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Saklanamazsa da tema bu oturum icin gecerli kalir - sorun degil.
    }
  }

  return [mode, setMode];
}
