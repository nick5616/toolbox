// Mirrors modules/archiver/validate.go (checkURL, maxInputs). Keep in sync.

export const MAX_URLS = 50;
export const URL_ERROR = "Enter a valid http or https link";
export const SCHEME_ERROR = "Only http and https links can be archived";
export const LOCAL_ERROR = "Local addresses are off. Turn on Allow local addresses to archive this";
export const MAX_URLS_MESSAGE = `At most ${MAX_URLS} links at a time`;

export interface ParsedLink {
  raw: string;
  host: string;
  /** Why it can't be saved, or undefined. */
  error?: string;
  count: number;
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) {
    return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h) || h.startsWith("::ffff:");
  }
  return false;
}

function check(raw: string, allowLocal: boolean): { host: string; error?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { host: "", error: URL_ERROR };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // "ftp://x", "file:///x" are a wrong scheme; "C:\x" or "foo" are just not links.
    return /^[a-z][a-z0-9+.-]+:\/\//i.test(raw) ? { host: "", error: SCHEME_ERROR } : { host: "", error: URL_ERROR };
  }
  if (u.hostname === "") return { host: "", error: URL_ERROR };
  const host = u.hostname.replace(/^www\./, "");
  if (!allowLocal && isLocalHost(u.hostname)) return { host, error: LOCAL_ERROR };
  return { host };
}

/** Splits on whitespace; duplicates collapse into one entry with `count`. */
export function parseLinks(text: string, allowLocal: boolean): ParsedLink[] {
  const out: ParsedLink[] = [];
  const seen = new Map<string, ParsedLink>();
  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    const prev = seen.get(token);
    if (prev) {
      prev.count++;
      continue;
    }
    const entry: ParsedLink = { raw: token, ...check(token, allowLocal), count: 1 };
    seen.set(token, entry);
    out.push(entry);
  }
  return out;
}

export function savableLinks(parsed: ParsedLink[]): string[] {
  return parsed.filter((p) => !p.error).map((p) => p.raw);
}

export function listError(parsed: ParsedLink[]): string | undefined {
  return savableLinks(parsed).length > MAX_URLS ? MAX_URLS_MESSAGE : undefined;
}
