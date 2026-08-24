import { useEffect, useRef } from "react";

/**
 * Esc tusuyla en ustteki acilir pencereyi kapatir.
 *
 * Ic ice pencerelerde (ornegin istasyon detayi uzerinde "Kiosk Ekle") her pencere
 * kendi dinleyicisini kurar; tek bir Esc'in hepsini birden kapatmamasi icin acik
 * pencereler bir yiginda tutulur ve sadece yiginin tepesindeki kapatilir.
 */
type Entry = { fire: () => void };

const stack: Entry[] = [];

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.stopPropagation();
  top.fire();
}

export function useEscapeKey(onEscape: () => void): void {
  // Callback her render'da yeniden olusuyor; yigin sirasinin bozulmamasi icin
  // dinleyici yalnizca bir kez kurulur, guncel callback ref uzerinden okunur.
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    const entry: Entry = { fire: () => latest.current() };
    stack.push(entry);
    if (stack.length === 1) document.addEventListener("keydown", onKeyDown);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
