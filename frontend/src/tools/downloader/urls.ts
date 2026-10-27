// Mirrors modules/downloader/validate.go (validateURL, maxInputs). Keep in sync.

export const MAX_URLS = 50;
export const URL_ERROR_MESSAGE = "Enter a valid http or https link";
export const MAX_URLS_MESSAGE = `At most ${MAX_URLS} links at a time`;

export interface ParsedUrl {
  raw: string;
  url?: URL;
  host: string;
  /** Path + query, for display. */
  path: string;
  valid: boolean;
  error?: string;
  /** How many times this exact token appeared (duplicates collapse). */
  count: number;
}

// Go's url.Parse leaves "http:foo" opaque (no host); WHATWG URL would accept it,
// so require the "//" authority explicitly.
const HTTP_AUTHORITY = /^https?:\/\/[^/?#\s]/i;

function parseOne(raw: string): Omit<ParsedUrl, "count"> {
  const bad = (): Omit<ParsedUrl, "count"> => ({ raw, host: "", path: "", valid: false, error: URL_ERROR_MESSAGE });
  if (!HTTP_AUTHORITY.test(raw)) return bad();
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return bad();
    const path = url.pathname === "/" && !url.search ? "" : url.pathname + url.search;
    return { raw, url, host: url.hostname.replace(/^www\./, ""), path, valid: true };
  } catch {
    return bad();
  }
}

/** Splits on whitespace; duplicates (exact same token) collapse into one entry with `count`. */
export function parseUrls(text: string): ParsedUrl[] {
  const out: ParsedUrl[] = [];
  const seen = new Map<string, ParsedUrl>();
  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    const prev = seen.get(token);
    if (prev) {
      prev.count++;
      continue;
    }
    const entry: ParsedUrl = { ...parseOne(token), count: 1 };
    seen.set(token, entry);
    out.push(entry);
  }
  return out;
}

/** Deduped, ordered valid URLs (what gets submitted). */
export function validUrls(parsed: ParsedUrl[]): string[] {
  return parsed.filter((p) => p.valid).map((p) => p.raw);
}

/** Error for the whole list (too many links), or undefined. */
export function urlsError(parsed: ParsedUrl[]): string | undefined {
  return validUrls(parsed).length > MAX_URLS ? MAX_URLS_MESSAGE : undefined;
}
