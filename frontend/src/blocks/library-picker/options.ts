// What a Library pick asks for (blocks/library-picker). Kept apart from the
// dialog so callers import it without pulling the dialog into start-up JS.

export interface LibraryPickOptions {
  /** Dialog title (default "Add from Library", or "Choose from Library" for one file). */
  title?: string;
  /** Extensions the caller accepts (".jpg" or "jpg", any case); null/empty = any file. */
  exts?: readonly string[] | null;
  /** Several files (default) or exactly one. */
  multiple?: boolean;
  /** Paths the caller already has: shown, but not pickable. */
  have?: Iterable<string>;
  /** Offer saved Photo Composer compositions. Default: when the caller accepts PNG pictures. */
  compositions?: boolean;
  /** The confirm button's label (default "Add N", or "Use" for one file). */
  confirmLabel?: string;
}

/** Lowercase extensions with their dot, without blanks or duplicates. */
export function normExts(exts: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of exts ?? []) {
    let e = raw.trim().toLowerCase();
    if (e === "" || e === ".") continue;
    if (!e.startsWith(".")) e = `.${e}`;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** Whether a pick offers compositions (they are exported as PNG). */
export function offersCompositions(exts: readonly string[], want: boolean | undefined): boolean {
  if (want !== undefined) return want;
  return exts.includes(".png");
}

/** The key a path is compared by (Windows paths are case-insensitive). */
export const libraryKey = (p: string) => p.replace(/\//g, "\\").toLowerCase();
