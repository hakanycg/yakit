import { useEffect, useState } from "react";
import { api } from "../shared/api";

const PING_INTERVAL_MS = 15_000;

/**
 * Kiosk, gercek bir istasyon ajani/fiziksel POS olmadan (bkz. gorev #76-77) merkez
 * sunucuya erisemedigi surece HICBIR sey yapamaz - yeni islem baslatamaz, odeme
 * alamaz, pompa kontrol edemez. Bu yuzden "cevrimdisi mod" burada kismi bir
 * calisma modu degil, sadece durumu ACIKCA iletip yeni islem baslatmayi
 * engelleyen bir tespit mekanizmasidir - bkz. KioskFlow.tsx.
 */
export function useConnectivity(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        await api.get("/api/health");
        if (!cancelled) setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    }

    check();
    const interval = setInterval(check, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return online;
}
