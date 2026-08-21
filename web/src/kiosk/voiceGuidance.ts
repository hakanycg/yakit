const STORAGE_KEY = "kiosk_voice_guidance";

/**
 * Erisilebilirlik: gorme engelli/az gorenler icin sesli yonlendirme ve buton
 * tiklamalarinda kisa bir sesli geri bildirim. Tarayicinin yerlesik Web Speech
 * (SpeechSynthesis) ve Web Audio API'leri kullanilir - harici bir ses dosyasi/
 * kutuphane gerekmez. Varsayilan olarak KAPALI baslar (beklenmedik sesli
 * anonsla musteriyi sasirtmamak icin), musteri kendi tercihiyle acar; tercih
 * dil secimi gibi bu tarayicida kalici olarak (localStorage) hatirlanir.
 */
export function isVoiceGuidanceEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setVoiceGuidanceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // localStorage erisilemez olabilir (ozel gezinti vb.) - tercih bu oturumda kalici olmaz.
  }
}

export function speak(text: string, lang: string): void {
  if (!isVoiceGuidanceEnabled()) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  window.speechSynthesis.speak(utterance);
}

let audioCtx: AudioContext | null = null;

/** Buton tiklamalarinda kisa bir "tik" sesi - hicbir ses dosyasi gerekmeden Web Audio ile uretilir. */
export function playClickSound(): void {
  if (!isVoiceGuidanceEnabled()) return;
  if (typeof window === "undefined") return;
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.08);
  } catch {
    // Ses cikisi olmayan/izin verilmeyen bir ortamda sessizce yok say.
  }
}
