/**
 * Section styles (SPEC §24.2): pure logic. One plan = cuts on the target video
 * track + a transition on each new clip + an adjustment clip over the range
 * that holds the chosen effects with their hits set to a lane.
 *
 * Cutting runs auto-fill with a one-rule recipe (as Cut to beat does, with a
 * min clip length), then the distribution modes re-point each new clip's in
 * point. Nothing here touches the document it is given.
 */
import type { EditClip, EditMoment, EditSourceState } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { NormalProject } from "@/viz/edit/defaults";
import { clipSourceSpan, newClip, newId, newTrack } from "../doc";
import { parseTransform, serializeEffects, serializeTransform, serializeTransition } from "@/viz/edit/schema";
import { editLength, type EditPost, type Marker, type MarkerLane } from "@/viz/edit/types";
import { postDef } from "@/viz/post/registry";
import type { TransitionKind } from "@/viz/types";
import { autofill, validateShape } from "../autofill/autofill";
import type { AutofillSource, Recipe, RecipeRule } from "../autofill/types";
import { HIT_LANES, readHit, writeHit } from "../beatsync/hits";
import { FX_STACKS } from "../inspector/FxStacks";
import { withVelocity } from "../beatsync/applyVelocity";
import type { VelocityShape } from "../beatsync/velocityRamp";

export const STYLE_TRACK_NAME = "Section styles";
export const MAX_TRACKS = 8;

export type CutLane = "keep" | MarkerLane;
export type Distribution = "cycle" | "shuffle" | "oneClip" | "best";
export type SourceMode = "all" | "selected" | "tags";

export interface StyleSettings {
  cutLane: CutLane;
  every: number;
  minClipMs: number;
  sourceMode: SourceMode;
  tags: string[];
  distribution: Distribution;
  /** "one clip, many moments": the source path ("" = the first video). */
  oneSource: string;
  mirror: boolean;
  /** An FX stack id, or "none". */
  stackId: string;
  /** The lane the effects follow; "cut" = the cut lane. */
  hitLane: "cut" | MarkerLane;
  /** 0..1 of each effect's range. */
  strength: number;
  transition: TransitionKind;
  transitionMs: number;
  /** Velocity ramps on the new clips ("off" = normal speed). */
  velocity: "off" | VelocityShape;
  velocityIntensity: number;
}

export const DEFAULT_SETTINGS: StyleSettings = {
  cutLane: "hats",
  every: 1,
  minClipMs: 150,
  sourceMode: "all",
  tags: [],
  distribution: "cycle",
  oneSource: "",
  mirror: false,
  stackId: "none",
  hitLane: "cut",
  strength: 0.8,
  transition: "cut",
  transitionMs: 200,
  velocity: "off",
  velocityIntensity: 0.7,
};

/** Cut lanes offered by the dialog (a subset of the hit lanes), plus "keep". */
export const STYLE_CUT_LANES: ReadonlyArray<{ value: CutLane; label: string }> = [
  { value: "keep", label: "Keep the current clips" },
  ...(["beat", "downbeat", "kick", "snare", "hats", "accent", "bass", "vocals"] as const).map((v) => ({ value: v as CutLane, label: HIT_LANES.find((l) => l.value === v)?.label ?? v })),
];

export const DISTRIBUTIONS: ReadonlyArray<{ value: Distribution; label: string; tip: string }> = [
  { value: "cycle", label: "Cycle evenly", tip: "Use the chosen sources one after another, in order" },
  { value: "shuffle", label: "Shuffle", tip: "Use the sources in a random order without repeating one until all are used" },
  { value: "oneClip", label: "One clip, many moments", tip: "Cut only one video, jumping between its shots and moments in order" },
  { value: "best", label: "Best moments", tip: "Each cut starts on a stand-out moment of its source (shot changes, bursts of movement); falls back to shot changes" },
];

export const laneLabel = (lane: MarkerLane): string => (HIT_LANES.find((l) => l.value === lane)?.label ?? lane).toLowerCase();

/** The lane the effects follow once "cut" is resolved. */
export function resolveHitLane(s: Pick<StyleSettings, "cutLane" | "hitLane">): MarkerLane {
  if (s.hitLane !== "cut") return s.hitLane;
  return s.cutLane === "keep" ? "beat" : s.cutLane;
}

// ---- range ----

export type Range = { fromMs: number; toMs: number };

/** Snaps to the nearest section edge or bar start within `tolMs`; otherwise to the ms. */
export function snapToGrid(ms: number, markers: readonly Marker[], tolMs = 200): number {
  let best = Math.round(ms);
  let bestD = tolMs + 1;
  for (const m of markers) {
    const edges = m.lane === "section" ? [m.ms, m.endMs ?? m.ms] : m.lane === "downbeat" ? [m.ms] : [];
    for (const e of edges) {
      const d = Math.abs(e - ms);
      if (d < bestD) {
        bestD = d;
        best = Math.round(e);
      }
    }
  }
  return best;
}

/** The range to style: a selected range, the selected clips' span, else the section under the playhead, else the whole edit. */
export function rangeFromContext(
  p: NormalProject,
  markers: readonly Marker[],
  selection: { kind: string; fromMs?: number; toMs?: number; ids?: string[] } | null,
  playheadMs: number,
): Range {
  if (selection?.kind === "range" && selection.fromMs !== undefined && selection.toMs !== undefined) return { fromMs: selection.fromMs, toMs: selection.toMs };
  if (selection?.kind === "clips" && selection.ids?.length) {
    const ids = new Set(selection.ids);
    const cs = p.tracks.flatMap((t) => t.clips).filter((c) => ids.has(c.id));
    if (cs.length) return { fromMs: Math.min(...cs.map((c) => c.startMs)), toMs: Math.max(...cs.map((c) => c.endMs)) };
  }
  const sec = markers.find((m) => m.lane === "section" && m.endMs !== undefined && m.ms <= playheadMs && playheadMs < (m.endMs as number));
  if (sec) return { fromMs: sec.ms, toMs: sec.endMs as number };
  return { fromMs: 0, toMs: editLength(p) };
}

// ---- density ----

/** Cut times a lane gives inside a range: every Nth marker, no two closer than minClipMs. */
export function cutDensity(markers: readonly Marker[], lane: MarkerLane, every: number, minClipMs: number, range: Range): number[] {
  const step = Math.max(1, Math.floor(every));
  const ms = markers
    .filter((m) => m.lane === lane)
    .map((m) => m.ms)
    .sort((x, y) => x - y);
  const out: number[] = [];
  let last = -Infinity;
  ms.forEach((t, i) => {
    if (i % step !== 0 || t < range.fromMs || t >= range.toMs) return;
    if (t - last < minClipMs) return;
    out.push(t);
    last = t;
  });
  return out;
}

// ---- sources ----

export function resolveSources(all: readonly AutofillSource[], mode: SourceMode, selected: readonly string[], tags: readonly string[]): AutofillSource[] {
  if (mode === "selected") return all.filter((s) => selected.includes(s.path));
  if (mode === "tags") return all.filter((s) => s.tags.some((t) => tags.includes(t)));
  return [...all];
}

// ---- plan ----

export interface StyleInput {
  project: NormalProject;
  markers: Marker[];
  analysis: Analysis;
  /** Every ready source. */
  sources: AutofillSource[];
  /** The Sources panel selection. */
  selectedPaths: readonly string[];
  /** Footage moments by source path (only needed by "oneClip" and "best"). */
  moments: Record<string, readonly EditMoment[] | undefined>;
  range: Range;
  settings: StyleSettings;
  seed: number;
  /** Target video track; unknown/"new" = a new "Cuts" track. */
  trackId: string;
  /** Source states (durations, for velocity ramps that stay inside the footage). */
  sourceStates?: Record<string, EditSourceState | undefined>;
}

export interface StylePlan {
  project: NormalProject | null;
  /** New clips cut (0 for "keep"). */
  cuts: number;
  /** Clips that got the transition/mirror (new clips, or the kept ones). */
  styled: number;
  hasEffects: boolean;
  problem: string | null;
  summary: string;
}

const failure = (problem: string): StylePlan => ({ project: null, cuts: 0, styled: 0, hasEffects: false, problem, summary: "" });

/** Removes the non-pinned clips' part inside [a,b] from a track; pieces outside stay (trimmed). */
export function clearRange(clips: readonly EditClip[], a: number, b: number, fps: number): EditClip[] {
  const out: EditClip[] = [];
  const frame = 1000 / fps;
  for (const c of clips) {
    if (c.pinned || c.endMs <= a || c.startMs >= b) {
      out.push(c);
      continue;
    }
    if (c.startMs < a && a - c.startMs >= frame) out.push({ ...c, endMs: a });
    if (c.endMs > b && c.endMs - b >= frame) {
      const shift = c.kind === "video" ? clipSourceSpan({ ...c, endMs: b }, fps).toMs - c.inMs : 0;
      out.push({ ...c, id: newId("c"), startMs: b, inMs: c.kind === "video" ? Math.max(0, c.inMs + shift) : c.inMs, in: "" });
    }
  }
  return out;
}

/** Adjustment clips overlapping the range are replaced: neighbours are trimmed (or split around it). */
export function clearAdjustRange(clips: readonly EditClip[], a: number, b: number): EditClip[] {
  const out: EditClip[] = [];
  for (const c of clips) {
    if (c.endMs <= a || c.startMs >= b) {
      out.push(c);
      continue;
    }
    if (c.startMs < a) out.push({ ...c, endMs: a });
    if (c.endMs > b) out.push(c.startMs < a ? { ...c, id: newId("c"), startMs: b } : { ...c, startMs: b });
  }
  return out.sort((x, y) => x.startMs - y.startMs);
}

/** The chosen stack with each reacting effect's main parameter following `lane` at `strength`. */
export function styleEffects(stackId: string, lane: MarkerLane, strength: number): EditPost[] {
  const stack = FX_STACKS.find((s) => s.id === stackId);
  if (!stack) return [];
  return stack.make().map((fx) => {
    const specs = postDef(fx.type)?.params;
    if (!specs) return fx;
    const cur = readHit(fx, specs);
    // Effects with a fixed look (Manga, VHS…) have no hit to re-point.
    if (!cur || cur.mode === "off" || cur.mode === "on") return fx;
    return writeHit(fx, specs, { mode: lane, strength, every: 1, decayMs: cur.decayMs });
  });
}

const mirrorOf = (c: EditClip): EditClip => {
  const t = parseTransform(c.transform).value;
  return { ...c, transform: serializeTransform({ ...t, edges: "mirror" }) };
};

/** Re-points the in point of each new video clip per the distribution mode. */
export function distribute(clips: EditClip[], sources: readonly AutofillSource[], moments: StyleInput["moments"], mode: Distribution, fps: number): EditClip[] {
  if (mode !== "oneClip" && mode !== "best") return clips;
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const frame = Math.round(1000 / fps);
  // Points of a source, in the order they are used.
  const pointsOf = (path: string): number[] => {
    const s = byPath.get(path);
    const dur = s?.durationMs ?? 0;
    const ms = moments[path] ?? [];
    let pts: number[];
    if (mode === "best") {
      const ranked = ms.slice().sort((x, y) => y.strength - x.strength || x.ms - y.ms);
      pts = ranked.map((m) => m.ms);
    } else {
      pts = [...new Set([...ms.map((m) => m.ms), ...(s?.shots ?? [])])].sort((x, y) => x - y);
    }
    if (pts.length === 0) pts = (s?.shots ?? []).slice().sort((x, y) => x - y);
    return pts.filter((t) => t >= 0 && t < dur);
  };
  const cache = new Map<string, number[]>();
  const cursor = new Map<string, number>();
  return clips.map((c) => {
    if (c.kind !== "video") return c;
    const src = byPath.get(c.path);
    if (!src) return c;
    const len = c.endMs - c.startMs;
    const latest = Math.max(0, src.durationMs - len);
    let pts = cache.get(c.path);
    if (!pts) {
      pts = pointsOf(c.path);
      cache.set(c.path, pts);
    }
    if (pts.length === 0) return c; // fallback: the shot-aligned in point auto-fill chose
    const start = cursor.get(c.path) ?? 0;
    // The next point (wrapping) that leaves room for the whole clip; else the first, clamped.
    let k = -1;
    for (let j = 0; j < pts.length; j++) {
      if ((pts[(start + j) % pts.length] as number) <= latest) {
        k = (start + j) % pts.length;
        break;
      }
    }
    const used = k >= 0 ? k : start % pts.length;
    cursor.set(c.path, used + 1);
    const inMs = Math.max(0, Math.min(latest, Math.round(pts[used] as number)));
    return { ...c, inMs: Math.max(0, Math.min(latest, Math.round(inMs / frame) * frame)) };
  });
}

export function planStyle(input: StyleInput): StylePlan {
  const { project, markers, analysis, settings: s } = input;
  const fps = project.fps > 0 ? project.fps : 30;
  const D = editLength(project);
  const a = Math.max(0, Math.round(input.range.fromMs));
  const b = Math.min(D, Math.round(input.range.toMs));
  if (b - a < 1000 / fps) return failure("The range is empty");

  const pool = resolveSources(input.sources, s.sourceMode, input.selectedPaths, s.tags);
  let tracks = project.tracks.slice();

  // ---- the target video track ----
  let targetId = input.trackId;
  if (!tracks.some((t) => t.id === targetId && t.kind === "video" && !t.locked)) {
    const first = tracks.find((t) => t.kind === "video" && !t.locked);
    if (first) targetId = first.id;
    else {
      const t = { ...newTrack("video", "Cuts"), clips: [] as EditClip[] };
      tracks = [...tracks, t];
      targetId = t.id;
    }
  }

  const newIds = new Set<string>();
  let cuts = 0;
  let touched: EditClip[] = []; // the clips that get the transition and mirror

  if (s.cutLane === "keep") {
    const t = tracks.find((x) => x.id === targetId);
    touched = (t?.clips ?? []).filter((c) => !c.pinned && c.startMs >= a && c.endMs <= b);
    touched.forEach((c) => newIds.add(c.id));
  } else {
    if (pool.length === 0) return failure("There are no sources to cut from");
    let use = pool;
    if (s.distribution === "oneClip") {
      const videos = pool.filter((x) => x.kind === "video");
      const one = videos.find((x) => x.path === s.oneSource) ?? videos[0];
      if (!one) return failure("Pick a video for \"One clip, many moments\"");
      use = [one];
    }
    const track = tracks.find((x) => x.id === targetId);
    const cleared = clearRange(track?.clips ?? [], a, b, fps);
    const base: NormalProject = { ...project, tracks: tracks.map((x) => (x.id === targetId ? { ...x, clips: cleared } : x)) };
    const rule: RecipeRule = {
      cutLane: s.cutLane,
      every: Math.max(1, s.every),
      minClipMs: Math.max(50, s.minClipMs),
      sourceOrder: s.distribution === "shuffle" ? "shuffleNoRepeat" : "sequential",
      videoIn: "shotAligned",
    };
    const recipe: Recipe = { id: "section-style", name: "Section style", description: "", rules: [rule] };
    const res = autofill({
      project: base,
      markers,
      analysis,
      sources: input.sources,
      recipe,
      options: { recipeId: recipe.id, seed: input.seed, order: "recipe", sources: use.map((x) => x.path), trackId: targetId, range: { fromMs: a, toMs: b } },
    });
    if (res.clips.length === 0) return failure(res.warnings[0] ?? "Nothing to cut there");
    const fresh = distribute(
      res.clips.map((c) => ({ ...c, id: newId("c"), auto: true })),
      input.sources,
      input.moments,
      s.distribution,
      fps,
    );
    const merged = [...cleared, ...fresh].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
    fresh.forEach((c) => newIds.add(c.id));
    const bad = validateShape(merged, newIds, D);
    if (bad) return failure(bad);
    cuts = fresh.length;
    touched = fresh;
    tracks = tracks.map((x) => (x.id === targetId ? { ...x, clips: merged } : x));
  }

  // ---- transitions and mirrored edges on the touched clips ----
  const tin = serializeTransition({ kind: s.transition, ms: s.transition === "cut" ? 0 : Math.max(0, Math.min(2000, Math.round(s.transitionMs))) });
  const style = (c: EditClip): EditClip => {
    let n = c.kind === "video" || c.kind === "image" || c.kind === "color" ? { ...c, in: tin } : c;
    if (s.mirror && (n.kind === "video" || n.kind === "image")) n = mirrorOf(n);
    // Each new clip starts on a hit (the cut), so its velocity ramp slows there.
    if (s.velocity !== "off" && newIds.has(c.id)) n = withVelocity(n, { shape: s.velocity, hits: "cut", intensity: s.velocityIntensity }, input.markers, input.sourceStates ?? {});
    return n;
  };
  tracks = tracks.map((t) => (t.id !== targetId ? t : { ...t, clips: t.clips.map((c) => (newIds.has(c.id) ? style(c) : c)) }));

  // ---- the adjustment clip ----
  const hitLane = resolveHitLane(s);
  const effects = styleEffects(s.stackId, hitLane, s.strength);
  const hasEffects = effects.length > 0;
  const ai = tracks.findIndex((t) => t.kind === "adjust" && t.name === STYLE_TRACK_NAME);
  if (hasEffects || ai >= 0) {
    let at = ai;
    if (at < 0) {
      if (tracks.length >= MAX_TRACKS) return failure("The edit already has 8 tracks. Remove one to add the Section styles track.");
      tracks = [...tracks, { ...newTrack("adjust", STYLE_TRACK_NAME), clips: [] as EditClip[] }];
      at = tracks.length - 1;
    }
    const t = tracks[at];
    if (t?.locked && hasEffects) return failure("The Section styles track is locked");
    if (t && !t.locked) {
      const kept = clearAdjustRange(t.clips, a, b);
      const clips = hasEffects ? [...kept, newClip({ kind: "adjust", startMs: a, endMs: b, effects: serializeEffects(effects) })].sort((x, y) => x.startMs - y.startMs) : kept;
      tracks = tracks.map((x, i) => (i === at ? { ...x, clips } : x));
    }
  }
  if (tracks.length > MAX_TRACKS) return failure("The edit would have more than 8 tracks. Remove one first.");

  const stack = FX_STACKS.find((x) => x.id === s.stackId);
  const cutPart = s.cutLane === "keep" ? `${touched.length} clips kept` : `${cuts} clips switching on ${laneLabel(s.cutLane)}${s.every > 1 ? ` (every ${s.every})` : ""}`;
  const summary = `${cutPart}${stack ? `, ${stack.label} on ${laneLabel(hitLane)}` : ""}`;
  return { project: { ...project, tracks }, cuts, styled: touched.length, hasEffects, problem: null, summary };
}
