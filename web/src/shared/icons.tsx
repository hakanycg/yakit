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

/** Genel Bakis istatistik kutulari icin - ayni "soft, currentColor" prensibi. */
export function WalletIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M15 14.5h2.5" />
    </svg>
  );
}

export function CheckCircleIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3 10.5 15 16 9" />
    </svg>
  );
}

export function FuelIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M4 21V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v15" />
      <path d="M3 21h10" />
      <path d="M12 10h2l2.8 2.8V17a1.3 1.3 0 0 0 2.6 0v-4.3a1.8 1.8 0 0 0-.53-1.28L17 9.5" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M12 3.7 21 19.3H3L12 3.7Z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="16.5" x2="12" y2="16.55" />
    </svg>
  );
}

export function SyncIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M20 11A8 8 0 0 0 6.3 6.3" />
      <polyline points="6 2.8 6 6.8 10 6.8" />
      <path d="M4 13a8 8 0 0 0 13.7 4.7" />
      <polyline points="18 21.2 18 17.2 14 17.2" />
    </svg>
  );
}
