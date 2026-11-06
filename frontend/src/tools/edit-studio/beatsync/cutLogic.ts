/**
 * "Cut to the beat": switch clips on every Nth beat / downbeat / kick /
 * snare… It runs auto-fill with a one-rule recipe on a track and a range,
 * replacing the clips there that aren't pinned (pinned clips stay).
 */
import type { EditClip } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength, type Marker, type MarkerLane } from "@/viz/edit/types";
import { newTrack } from "@/editor/doc";
import type { EditSourceState as SourceState } from "@/lib/api";
import { autofill, validateShape } from "../autofill/autofill";
import type { AutofillSource, Recipe, RecipeRule } from "../autofill/types";

export interface CutOptions {
  lane: MarkerLane;
  every: number;
  order: "sequential" | "shuffleNoRepeat";
  /** Where in each source a clip starts. */
  moments: "start" | "random" | "shotAligned";
  /** Timeline ms; null = the whole edit. */
  range: { fromMs: number; toMs: number } | null;
  /** Target video track; "new" adds one on top. */
  trackId: string;
  /** Only these sources ("all" = every ready source). */
  sources: "all" | string[];
  seed: number;
}

/** The ready sources (video and photos), in Sources-panel order. */
export function readySources(p: NormalProject, states: Record<string, SourceState | undefined>): AutofillSource[] {
  const out: AutofillSource[] = [];
  for (const s of p.sources) {
    const st = states[s.path];
    if (!st || st.error) continue;
    const kind = st.info.kind === "video" || st.info.kind === "image" ? st.info.kind : null;
    if (!kind) continue;
    out.push({ path: s.path, kind, durationMs: st.info.durationMs, tags: s.tags ?? [], shots: st.shots });
  }
  return out;
}

export interface CutResult {
  project: NormalProject;
  cuts: number;
  trackId: string;
  problem: string | null;
}

export function cutToBeat(p: NormalProject, markers: Marker[], analysis: Analysis, sources: AutofillSource[], o: CutOptions): CutResult {
  const D = editLength(p);
  const a = o.range?.fromMs ?? 0;
  const b = o.range?.toMs ?? D;
  let next = p;
  let target = o.trackId;
  if (target === "new" || !p.tracks.some((t) => t.id === target && t.kind === "video")) {
    const t = { ...newTrack("video", "Cuts"), clips: [] as EditClip[] };
    next = { ...p, tracks: [...p.tracks, t] };
    target = t.id;
  }
  // Clips inside the range that aren't pinned get replaced.
  next = { ...next, tracks: next.tracks.map((t) => (t.id !== target ? t : { ...t, clips: t.clips.map((c) => (!c.pinned && c.startMs >= a && c.endMs <= b ? { ...c, auto: true } : c)) })) };
  const rule: RecipeRule = { cutLane: o.lane, every: Math.max(1, o.every), minClipMs: 100, sourceOrder: o.order, videoIn: o.moments };
  const recipe: Recipe = { id: "cut-to-beat", name: "Cut to the beat", description: "", rules: [rule] };
  const res = autofill({ project: next, markers, analysis, sources, recipe, options: { recipeId: recipe.id, seed: o.seed, order: "recipe", sources: o.sources, trackId: target, range: o.range } });
  const gone = new Set(res.removed);
  const tr = next.tracks.find((t) => t.id === target);
  if (!tr) return { project: p, cuts: 0, trackId: target, problem: "There's no track to cut on" };
  const clips = [...tr.clips.filter((c) => !gone.has(c.id)), ...res.clips].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const bad = validateShape(clips, new Set(res.clips.map((c) => c.id)), D);
  if (bad) return { project: p, cuts: 0, trackId: target, problem: bad };
  if (res.clips.length === 0) return { project: p, cuts: 0, trackId: target, problem: res.warnings[0] ?? "Nothing to cut there" };
  return { project: { ...next, tracks: next.tracks.map((t) => (t.id === target ? { ...t, clips } : t)) }, cuts: res.clips.length, trackId: target, problem: null };
}
