import type { SilenceAnalysis, SilenceOptions, SilenceRange } from "@/lib/api";
import { parseJson, num, str } from "@/tools/_kit/image/common";

/** Mirrors Go's DefaultOptions() (modules/silence). */
export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  thresholdDb: -35,
  minSilenceMs: 500,
  paddingMs: 150,
  crossfadeMs: 15,
  cutList: true,
};

/** The limits the Go side enforces. */
export const SILENCE_LIMITS = {
  thresholdDb: { min: -80, max: -10 },
  minSilenceMs: { min: 100, max: 10_000 },
  paddingMs: { min: 0, max: 2000 },
  crossfadeMs: { min: 0, max: 200 },
} as const;

function clampNum(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;
}

/** `sanitize` for useModuleOptions: valid fields over the defaults. */
export function sanitizeSilenceOptions(raw: unknown, defaults: SilenceOptions): SilenceOptions {
  const out = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const L = SILENCE_LIMITS;
  out.thresholdDb = clampNum(r.thresholdDb, out.thresholdDb, L.thresholdDb.min, L.thresholdDb.max);
  out.minSilenceMs = clampNum(r.minSilenceMs, out.minSilenceMs, L.minSilenceMs.min, L.minSilenceMs.max);
  out.paddingMs = clampNum(r.paddingMs, out.paddingMs, L.paddingMs.min, L.paddingMs.max);
  out.crossfadeMs = clampNum(r.crossfadeMs, out.crossfadeMs, L.crossfadeMs.min, L.crossfadeMs.max);
  if (typeof r.cutList === "boolean") out.cutList = r.cutList;
  return out;
}

/** "1:05" / "1:02:03" from milliseconds (tenths below a minute: "8.4 s"). */
export function formatSpan(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)} s`;
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** One line about what a cut would do. */
export function analysisSummary(a: Pick<SilenceAnalysis, "durationMs" | "removedMs" | "removed">): string {
  const cuts = a.removed?.length ?? 0;
  if (cuts === 0) return "Nothing is silent with these settings";
  const pct = a.durationMs > 0 ? Math.round((a.removedMs / a.durationMs) * 100) : 0;
  return `Would remove ${formatSpan(a.removedMs)} of ${formatSpan(a.durationMs)} (${pct}%) in ${cuts} ${cuts === 1 ? "cut" : "cuts"}`;
}

/** Ranges for the Timeline: the stretches that would be removed. */
export function removedRanges(removed: readonly SilenceRange[] | null | undefined): Array<{ id: string; startMs: number; endMs: number }> {
  return (removed ?? []).map((r, i) => ({ id: `cut${i}`, startMs: r.startMs, endMs: r.endMs }));
}

/** A finished cut, read from a job's resultJson. */
export interface CutOutcome {
  output: string;
  cutList: string;
  durationMs: number;
  removedMs: number;
  keptMs: number;
}

export function parseCut(json: string | null | undefined): CutOutcome | null {
  const r = parseJson(json);
  const output = r ? str(r.output) : "";
  if (!r || !output) return null;
  return { output, cutList: str(r.cutList), durationMs: num(r.durationMs), removedMs: num(r.removedMs), keptMs: num(r.keptMs) };
}

/** True when two option sets would be analysed identically (padding and the rest only matter for the cut). */
export function analysisKey(path: string, o: SilenceOptions): string {
  return [path, o.thresholdDb, o.minSilenceMs, o.paddingMs].join("|");
}
