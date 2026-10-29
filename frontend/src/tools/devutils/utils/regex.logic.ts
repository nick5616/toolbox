export const MAX_MATCHES = 1000;

export interface RegexMatch {
  index: number;
  end: number;
  text: string;
  groups: (string | undefined)[]; // numbered captures
  named: Record<string, string | undefined>;
}

export type RegexOutcome =
  | { ok: false; message: string }
  | { ok: true; matches: RegexMatch[]; truncated: boolean; replaced: string | null };

const VALID_FLAGS = "dgimsuvy";

export function checkFlags(flags: string): string | null {
  const seen = new Set<string>();
  for (const f of flags) {
    if (!VALID_FLAGS.includes(f)) return `Unknown flag "${f}"`;
    if (seen.has(f)) return `Flag "${f}" is repeated`;
    seen.add(f);
  }
  if (seen.has("u") && seen.has("v")) return 'Flags "u" and "v" can\'t be combined';
  return null;
}

/** Runs a JavaScript-flavour regex over `text`; `replacement` (null = none) previews String.replace. */
export function runRegex(pattern: string, flags: string, text: string, replacement: string | null): RegexOutcome {
  if (pattern === "") return { ok: true, matches: [], truncated: false, replaced: replacement === null ? null : text };
  const flagErr = checkFlags(flags);
  if (flagErr) return { ok: false, message: flagErr };
  let re: RegExp;
  let scan: RegExp;
  try {
    re = new RegExp(pattern, flags);
    scan = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "Invalid pattern" };
  }
  const global = flags.includes("g");
  const matches: RegexMatch[] = [];
  let truncated = false;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      text: m[0],
      groups: m.slice(1),
      named: { ...(m.groups ?? {}) },
    });
    if (!global) break;
    if (m[0] === "") scan.lastIndex++;
  }
  let replaced: string | null = null;
  if (replacement !== null) {
    try {
      replaced = text.replace(re, replacement);
    } catch {
      replaced = null;
    }
  }
  return { ok: true, matches, truncated, replaced };
}

export interface Segment {
  text: string;
  match: boolean;
  /** Index into the matches array when `match`. */
  n?: number;
}

/** Splits text into plain and matched segments (empty matches are skipped). */
export function segments(text: string, matches: readonly RegexMatch[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  matches.forEach((m, n) => {
    if (m.end === m.index || m.index < pos) return;
    if (m.index > pos) out.push({ text: text.slice(pos, m.index), match: false });
    out.push({ text: m.text, match: true, n });
    pos = m.end;
  });
  if (pos < text.length) out.push({ text: text.slice(pos), match: false });
  return out;
}
