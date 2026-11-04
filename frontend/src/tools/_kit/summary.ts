/** Joins the non-empty parts of an advanced-settings summary: `summarize("MP3", false, "320 kbps")` → "MP3 · 320 kbps". */
export function summarize(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}
