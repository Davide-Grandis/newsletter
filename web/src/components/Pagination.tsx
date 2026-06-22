import type { ReactNode } from 'react';

// Shared page size for every paginated table in the app.
export const PAGE_SIZE = 15;

// Cloudflare-style page window: up to 5 numbered buttons centred on the current
// page, clamped to the available range.
function pageWindow(page: number, pageCount: number): number[] {
  const span = 5;
  let start = Math.max(0, page - Math.floor(span / 2));
  const end = Math.min(pageCount, start + span);
  start = Math.max(0, end - span);
  return Array.from({ length: end - start }, (_, i) => start + i);
}

function PagerButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="min-w-[2rem] h-8 px-2 rounded text-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-400 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

/**
 * Cloudflare-dashboard-style pagination footer: "Showing X - Y of Z" on the
 * left, and «  ‹  [numbered pages]  ›  » controls on the right. Pages are
 * 0-indexed. Renders nothing when there is at most one page of results.
 */
export function Pagination({
  page,
  total,
  itemCount,
  busy,
  onPage,
  pageSize = PAGE_SIZE,
}: {
  page: number;
  total: number;
  itemCount: number;
  busy?: boolean;
  onPage: (page: number) => void;
  pageSize?: number;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const lastPage = pageCount - 1;
  if (total <= 0) return null;

  return (
    <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
      <span>
        Showing {page * pageSize + 1} - {page * pageSize + itemCount} of {total}
      </span>
      <div className="flex items-center gap-1">
        <PagerButton label="First page" onClick={() => onPage(0)} disabled={page === 0 || busy}>
          «
        </PagerButton>
        <PagerButton label="Previous page" onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0 || busy}>
          ‹
        </PagerButton>
        {pageWindow(page, pageCount).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onPage(n)}
            disabled={busy}
            aria-current={n === page ? 'page' : undefined}
            className={`min-w-[2rem] h-8 px-2 rounded border text-center ${
              n === page
                ? 'border-slate-300 bg-slate-100 text-slate-900 font-medium dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
                : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {n + 1}
          </button>
        ))}
        <PagerButton label="Next page" onClick={() => onPage(Math.min(lastPage, page + 1))} disabled={page >= lastPage || busy}>
          ›
        </PagerButton>
        <PagerButton label="Last page" onClick={() => onPage(lastPage)} disabled={page >= lastPage || busy}>
          »
        </PagerButton>
      </div>
    </div>
  );
}
