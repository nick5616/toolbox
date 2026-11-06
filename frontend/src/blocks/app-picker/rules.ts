import type { FocusAllowRule, FocusApp } from "@/lib/api";

export type RuleKind = "folder" | "exe";

function isBundle(path: string): boolean {
  return /\.app[\\/]?$/i.test(path);
}

/** The containing folder of a program path (either separator); a macOS bundle is its own folder. */
export function parentDir(path: string): string {
  if (isBundle(path)) return path.replace(/[\\/]+$/, "");
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

/** The app's rule as a folder rule or an exe rule: its suggestion when the kind matches, else rebuilt from the program's path. */
export function ruleFor(app: FocusApp, kind: RuleKind): FocusAllowRule {
  if (app.rule.kind === kind) return app.rule;
  return { ...app.rule, kind, path: kind === "exe" ? app.path : parentDir(app.path) };
}

export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Lettered tile text for an app: its first letter or digit, uppercased. */
export function tileLetter(label: string): string {
  const m = /[\p{L}\p{N}]/u.exec(label);
  return (m?.[0] ?? "?").toUpperCase();
}
