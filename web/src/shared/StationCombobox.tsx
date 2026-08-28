import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import type { Station } from "./types";

/**
 * Aranabilir istasyon secici. Duz bir <select> binlerce istasyonda kullanilamaz hale
 * gelir (tarayicinin native acilir listesinde arama/filtreleme yoktur, tumu tek
 * seferde DOM'a basilir). Bunun yerine yazildikca (debounce'lu) sunucuya sorulur
 * (bkz. GET /api/stations/search) - istemciye asla tum istasyon listesi gonderilmez.
 */
export default function StationCombobox({
  id,
  value,
  onSelect,
  placeholder = "İstasyon adı veya kodu ile arayın...",
  required,
}: {
  id?: string;
  value: Station | null;
  onSelect: (station: Station | null) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Station[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const requestId = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    const thisRequest = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ stations: Station[] }>(`/api/stations/search?q=${encodeURIComponent(query.trim())}&limit=20`)
        .then((res) => {
          // Yazarken art arda giden isteklerden GECIKMIS (eski) bir yanit gelirse
          // yoksayilir - aksi halde daha yeni bir sorgunun sonucu, daha once giden
          // ama gec donen eski bir sorgunun sonucuyla ustune yazilirdi.
          if (thisRequest !== requestId.current) return;
          setResults(res.stations);
          setHighlighted(0);
        })
        .finally(() => {
          if (thisRequest === requestId.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  function selectStation(s: Station) {
    onSelect(s);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = results[highlighted];
      if (s) selectStation(s);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const displayValue = open ? query : value ? `${value.name}${value.code ? ` (${value.code})` : ""}` : "";

  return (
    <div className="combobox" ref={containerRef}>
      <input
        id={id}
        value={displayValue}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) onSelect(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        required={required && !value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <ul className="combobox-list">
          {loading && <li className="combobox-empty">Aranıyor...</li>}
          {!loading && results.length === 0 && (
            <li className="combobox-empty">{query.trim() ? "Sonuç bulunamadı." : "Yazmaya başlayın..."}</li>
          )}
          {!loading &&
            results.map((s, i) => (
              <li
                key={s.id}
                className={i === highlighted ? "active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectStation(s);
                }}
                onMouseEnter={() => setHighlighted(i)}
              >
                {s.name} {s.code ? `(${s.code})` : ""}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
