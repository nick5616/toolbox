import { SceneKeep, SceneOutput, type SceneInfo, type ScenesOptions } from "@/lib/api";
import type { JobView } from "@/state/jobs";
import { basename, num, parseJson, str } from "@/tools/_kit/image/common";

/** Mirrors Go's DefaultOptions() (modules/scenes). */
export const DEFAULT_SCENES_OPTIONS: ScenesOptions = {
  threshold: 0.3,
  minSceneSecs: 1,
  output: SceneOutput.OutputBoth,
  keep: SceneKeep.KeepAll,
  keepN: 10,
};

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: saved values over the defaults, out-of-range ones clamped. */
export function sanitizeScenesOptions(raw: unknown, defaults: ScenesOptions): ScenesOptions {
  const out: ScenesOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.threshold = clamp(r.threshold, 0.05, 0.9, out.threshold);
  out.minSceneSecs = clamp(r.minSceneSecs, 0.2, 60, out.minSceneSecs);
  out.output = oneOf(SceneOutput, r.output) ?? out.output;
  out.keep = oneOf(SceneKeep, r.keep) ?? out.keep;
  out.keepN = Math.round(clamp(r.keepN, 1, 200, out.keepN));
  return out;
}

export interface SceneItem {
  n: number;
  startMs: number;
  endMs: number;
  clip: string;
  still: string;
}

export interface ScenesResultItem {
  id: string;
  title: string;
  found: number;
  scenes: SceneItem[];
  reencoded: number;
  /** Library output id and missing flag by path. */
  files: Map<string, { id: string; missing: boolean }>;
}

/** Result card data for a finished job; null when the result is missing. */
export function toScenesResult(job: JobView): ScenesResultItem | null {
  const r = parseJson(job.resultJson);
  if (!r) return null;
  const list = Array.isArray(r.scenes) ? (r.scenes as Array<Partial<SceneInfo>>) : [];
  const scenes = list.map((s) => ({
    n: num(s.n),
    startMs: num(s.startMs),
    endMs: num(s.endMs),
    clip: str(s.clip),
    still: str(s.still),
  }));
  const files = new Map<string, { id: string; missing: boolean }>();
  for (const o of job.outputs) files.set(o.path, { id: o.id, missing: o.missing });
  const input = job.inputs[0];
  return {
    id: job.id,
    title: input ? basename(input) : job.title,
    found: num(r.found),
    scenes,
    reencoded: num(r.reencoded),
    files,
  };
}

/** "12 scenes" / "3 of 12 scenes". */
export function sceneCountText(item: ScenesResultItem): string {
  const kept = item.scenes.length;
  const noun = (n: number) => (n === 1 ? "scene" : "scenes");
  return item.found > kept ? `${kept} of ${item.found} ${noun(item.found)}` : `${kept} ${noun(kept)}`;
}

/** The summary line of the Advanced click-in. */
export function scenesSummary(o: ScenesOptions): string {
  return `Sensitivity ${o.threshold} · scenes of at least ${o.minSceneSecs} s`;
}
