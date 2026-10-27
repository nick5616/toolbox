/** Lower-cased extension of a path without the dot ("" if none). */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** True when `path` has one of `extensions` (case-insensitive, dots optional). Empty list accepts all. */
export function acceptsPath(extensions: readonly string[], path: string): boolean {
  if (extensions.length === 0) return true;
  const ext = extOf(path);
  return extensions.some((e) => e.replace(/^\./, "").toLowerCase() === ext);
}
