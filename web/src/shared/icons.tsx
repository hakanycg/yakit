/**
 * Topbar'daki basic ikonlar (hamburger menu, gunes/ay) - emoji yerine tek renkli
 * (currentColor) SVG cizgi ikonlar. Emoji glifleri isletim sistemine gore sabit,
 * cok renkli (sari gunes, gri ay vb.) geldigi icin gece/gunduz temasiyla uyumsuz
 * duruyordu ("renk karmasasi"); bu ikonlar butonun metin rengini (var(--text-dim))
 * miras alir, boylece her iki temada da yumusak/notr gorunur.
 */

const common = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function MenuIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

export function SunIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21.5" />
      <line x1="4.2" y1="4.2" x2="6" y2="6" />
      <line x1="18" y1="18" x2="19.8" y2="19.8" />
      <line x1="2.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21.5" y2="12" />
      <line x1="4.2" y1="19.8" x2="6" y2="18" />
      <line x1="18" y1="6" x2="19.8" y2="4.2" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.7 6.7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}
