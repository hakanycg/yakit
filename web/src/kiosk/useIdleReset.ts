import { useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "touchstart", "keydown"] as const;

/**
 * Kiosk halka acik bir terminal oldugu icin, bir musteri islem ortasinda (ör. plaka
 * girdikten sonra) uzaklasirsa ekran suresiz oyle kalmamali - hem siradaki musteriyi
 * bekletir hem de onceki musterinin plakasi/bilgileri ekranda gorunur kalir. `warningMs`
 * suresi boyunca hicbir etkilesim olmazsa bir uyari gosterilir; `countdownMs` icinde de
 * yanit gelmezse `onIdle` cagrilir (KioskFlow'da bu, akisi baslangica sifirlayan `reset()`).
 *
 * `enabled=false` iken (ör. odeme/dolum adimlarinda) hicbir sey yapmaz - fiziksel dolum
 * veya kart odemesi surerken ekranin kendiliginden sifirlanip musteriyi yaniltmasi
 * istenmez; bu adimlarin tamamlanmasi surece degil, dogrudan islem durumuna baglidir.
 */
export function useIdleReset(enabled: boolean, onIdle: () => void, warningMs = 60_000, countdownMs = 20_000) {
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(countdownMs / 1000));
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  function clearTimers() {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    warningTimer.current = null;
    countdownInterval.current = null;
  }

  function startCountdown() {
    setWarning(true);
    setSecondsLeft(Math.round(countdownMs / 1000));
    const deadline = Date.now() + countdownMs;
    countdownInterval.current = setInterval(() => {
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        // onIdle (reset()) akisi baslangica dondurur ama bu, uyari kutusunu kendiliginden
        // kapatmaz - resetTimer() cagirmadan birakilirsa uyari, sifirlanmis "plate" ekraninin
        // ustunde asili kalir ve siradaki musteriyi karsilar. resetTimer() hem uyariyi
        // kapatir hem de (enabled hala true oldugundan) yeni bir bosta-kalma dongusu baslatir.
        onIdleRef.current();
        resetTimer();
      }
    }, 250);
  }

  function resetTimer() {
    clearTimers();
    setWarning(false);
    if (!enabled) return;
    warningTimer.current = setTimeout(startCountdown, warningMs);
  }

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      setWarning(false);
      return;
    }
    resetTimer();
    // Herhangi bir gercek etkilesim (uyari gosteriliyor olsun ya da olmasin) zamanlayiciyi
    // sifirlar - kullanicinin hala orada oldugunu gosteren tek sey budur.
    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, resetTimer);
    return () => {
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, resetTimer);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    warning,
    secondsLeft,
    /** Uyari gosterilirken "hala buradayim" gibi bir onaylama ile geri sayimi iptal edip normal bosta-kalma suresini yeniden baslatir. */
    dismiss: resetTimer,
  };
}
