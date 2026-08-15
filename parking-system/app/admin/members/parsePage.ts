// Wave 1c (#5A) — `?page=` is public input, so it gets its own tested parser rather than an inline
// Number() in the page (a page file also can't export arbitrary helpers for tests to import).
//
// Accept only a plain positive safe integer:
//   - the regex rejects '1.5', '1e3', 'Infinity', '-1', '' and any non-digit outright
//   - the safe-integer check rejects digit strings too large to page with, which would otherwise
//     produce a fractional/overflowing offset and a broken range
// searchParams values can be string[] (?page=1&page=2) — that is not a page, so → 1.
// A bad page is not worth a 500: fall back to the first page.
export function parsePage(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 1
  const page = Number(raw)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}
