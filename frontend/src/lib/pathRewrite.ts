/**
 * The pure half of `displayPath` (SPEC A5): rewriting paths and free text for display when
 * "Hide personal details" is on. No imports, so `lib/errors.ts` can use it without a cycle;
 * `state/workspace.ts` keeps `current` up to date.
 */

/** The presenter's shape (mirrors the generated `WorkspacePresenter`). */
export interface Presenter {
  on: boolean;
  root: string;
  name: string;
  home: string;
}

export const PRESENTER_OFF: Presenter = { on: false, root: "", name: "", home: "" };

let current: Presenter = PRESENTER_OFF;

/** The presenter the shell last loaded (OFF until then). */
export function currentPresenter(): Presenter {
  return current;
}

export function setCurrentPresenter(p: Presenter | null): void {
  current = p ?? PRESENTER_OFF;
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.includes("\\");
}

/** Trailing separators off, both slash styles to "/". */
function norm(p: string): string {
  return p.replaceAll("\\", "/").replace(/\/+$/, "");
}

/** The part of `p` below `base` ("" when equal), or null when `p` is not inside `base`. */
function below(p: string, base: string, fold: boolean): string | null {
  const b = norm(base);
  if (!b) return null;
  const q = norm(p);
  const qq = fold ? q.toLowerCase() : q;
  const bb = fold ? b.toLowerCase() : b;
  if (qq === bb) return "";
  if (qq.startsWith(bb + "/")) return q.slice(b.length + 1);
  return null;
}

function join(prefix: string, rest: string): string {
  return rest ? `${prefix}/${rest}` : prefix;
}

/**
 * Rewrites a path for display: inside the workspace root -> `<Name>/...`, inside the home
 * folder -> `~/...`, anything else unchanged. Unchanged when `on` is false.
 */
export function rewritePath(p: string, pr: Presenter): string {
  if (!pr.on || !p) return p;
  const fold = isWindowsPath(p) || isWindowsPath(pr.root) || isWindowsPath(pr.home);
  if (pr.root) {
    const rest = below(p, pr.root, fold);
    if (rest !== null) return join(pr.name || "Workspace", rest);
  }
  if (pr.home) {
    const rest = below(p, pr.home, fold);
    if (rest !== null) return join("~", rest);
  }
  return p;
}

const REGEX_SPECIAL = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);

function escapeRe(s: string): string {
  return Array.from(s)
    .map((c) => (REGEX_SPECIAL.has(c) ? `\\${c}` : c))
    .join("");
}

/** A regex that matches `base` written with either slash style, followed by the rest of the path token. */
function tokenRe(base: string): RegExp | null {
  const b = norm(base);
  if (!b) return null;
  const sep = String.raw`[\\/]`;
  const body = b.split("/").map(escapeRe).join(sep);
  return new RegExp(String.raw`${body}(?![\w.-])(?:${sep}[^\s"'<>|,;)]*)?`, isWindowsPath(base) ? "gi" : "g");
}

/** Rewrites every path inside free text (errors, hints, log lines). */
export function rewriteText(s: string, pr: Presenter): string {
  if (!pr.on || !s) return s;
  let out = s;
  for (const [base, prefix] of [
    [pr.root, pr.name || "Workspace"],
    [pr.home, "~"],
  ] as const) {
    const re = tokenRe(base);
    if (!re) continue;
    out = out.replace(re, (m) => rewritePath(m, { on: true, root: base, name: prefix, home: "" }));
  }
  return out;
}
