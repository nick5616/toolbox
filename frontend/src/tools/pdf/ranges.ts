/** Page-range syntax used by Split and PDF → images: "1-3, 5, 8-" (8- = to the end). */

export interface RangeItem {
  /** The trimmed source token. */
  text: string;
  start: number;
  /** null = to the last page. */
  end: number | null;
  /** Chip text: "1–3", "5", "8–end". */
  label: string;
  error?: string;
}

export interface ParsedRanges {
  items: RangeItem[];
  /** First error message, or "". */
  error: string;
}

const TOKEN = /^(\d+)(?:\s*[-–]\s*(\d*))?$/;

/** Parses `text`; when `total` (page count) is known, ranges are checked against it. */
export function parseRanges(text: string, total?: number): ParsedRanges {
  const items: RangeItem[] = [];
  let error = "";
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    const m = TOKEN.exec(token);
    if (!m) {
      items.push({ text: token, start: 0, end: null, label: token, error: `"${token}" isn't a page range` });
      error ||= `"${token}" isn't a page range`;
      continue;
    }
    const start = Number(m[1]);
    const hasDash = token.includes("-") || token.includes("–");
    const endText = m[2] ?? "";
    const end = hasDash ? (endText === "" ? null : Number(endText)) : start;
    const label = end === null ? `${start}–end` : end === start ? `${start}` : `${start}–${end}`;
    let err = "";
    if (start < 1) err = "Pages start at 1";
    else if (end !== null && end < start) err = `"${token}" ends before it starts`;
    else if (total !== undefined && total > 0 && start > total) err = `Page ${start} is past the last page (${total})`;
    else if (total !== undefined && total > 0 && end !== null && end > total) err = `Page ${end} is past the last page (${total})`;
    items.push(err ? { text: token, start, end, label, error: err } : { text: token, start, end, label });
    if (err) error ||= err;
  }
  if (items.length === 0) error = "Enter at least one page range";
  return { items, error };
}

/** Number of distinct pages covered by valid ranges, given the page count. */
export function countPages(items: readonly RangeItem[], total: number): number {
  const seen = new Set<number>();
  for (const it of items) {
    if (it.error) continue;
    const end = it.end ?? total;
    for (let p = it.start; p <= Math.min(end, total); p++) seen.add(p);
  }
  return seen.size;
}
