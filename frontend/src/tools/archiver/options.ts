import type { ArchiverOptions } from "@/lib/api";

export const MODULE_ID = "archiver";

// Mirrors modules/archiver/options.go.
export const MIN_TIMEOUT = 10;
export const MAX_TIMEOUT = 300;

export const DEFAULT_OPTIONS: ArchiverOptions = {
  urls: [],
  renderJs: false,
  noJs: false,
  noImages: false,
  alsoPdf: false,
  timeoutSec: 60,
  allowLocal: false,
};

/** Saved module state over the defaults; anything invalid is ignored. */
export function sanitizeOptions(raw: unknown, defaults: ArchiverOptions): ArchiverOptions {
  const out: ArchiverOptions = { ...defaults, urls: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of ["renderJs", "noJs", "noImages", "alsoPdf", "allowLocal"] as const) {
    if (typeof r[k] === "boolean") out[k] = r[k];
  }
  if (typeof r.timeoutSec === "number" && Number.isInteger(r.timeoutSec) && r.timeoutSec >= MIN_TIMEOUT && r.timeoutSec <= MAX_TIMEOUT) {
    out.timeoutSec = r.timeoutSec;
  }
  return out;
}

/** One-line state of the Advanced click-in. */
export function advancedSummary(o: ArchiverOptions): string {
  const parts: string[] = [];
  if (o.noJs) parts.push("no scripts");
  if (o.noImages) parts.push("no images");
  if (o.allowLocal) parts.push("local addresses");
  if (o.timeoutSec !== DEFAULT_OPTIONS.timeoutSec) parts.push(`${o.timeoutSec} s timeout`);
  return parts.length === 0 ? "Defaults" : parts.join(" · ");
}
