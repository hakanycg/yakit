/**
 * Sayfa numarali (1-2-3-4-5...) gezinme kontrolu - veriler buyudukce (binlerce
 * istasyon/kiosk/islem) tum listeyi tek seferde gostermek yerine birden fazla
 * sayfada bes-onemli-yerde kullanilir (bkz. Alarms.tsx, Stations.tsx, Portfolio.tsx,
 * KioskFleet.tsx, Tenants.tsx, Transactions.tsx, FuelStock.tsx).
 */
function pageWindow(page: number, pageCount: number): (number | "...")[] {
  const pages: (number | "...")[] = [];
  const middle: number[] = [];
  for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) middle.push(i);

  pages.push(1);
  if (middle[0] !== undefined && middle[0] > 2) pages.push("...");
  pages.push(...middle);
  if (middle[middle.length - 1] !== undefined && middle[middle.length - 1]! < pageCount - 1) pages.push("...");
  if (pageCount > 1) pages.push(pageCount);
  return pages;
}

export default function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className="pagination" aria-label="Sayfalar">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Önceki sayfa">
        ‹
      </button>
      {pageWindow(page, pageCount).map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="pagination-ellipsis">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={p === page ? "active" : ""}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        )
      )}
      <button type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Sonraki sayfa">
        ›
      </button>
    </nav>
  );
}
