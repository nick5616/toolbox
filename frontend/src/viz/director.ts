/**
 * The director (SPEC.md §6.9): which scene plays when.
 *
 * - Auto mode maps each section to a scene (the preset's `sceneFor`, else the
 *   default map) with a transition on the nearest downbeat. A drop flashes, a
 *   chorus that follows a build-up zooms, everything else crossfades.
 * - With `director.follow === "emotion"` (Mood Field) the scenes follow the
 *   mood keyframes of the words instead of the sections; changes land on
 *   downbeats and a scene lasts at least two bars.
 * - Manual mode uses the show's own entries.
 * - `motifsAt` lists the motif layers the words ask for at a time. The engine
 *   draws them on top of the active scene.
 */
import type { Analysis, Section, TextLine } from "./analysis";
import type { Emotion, LayerConfig, Motif, SectionLabel, Show, TimelineEntry, Transition } from "./types";

export const DEFAULT_SCENE_FOR: Record<SectionLabel, string> = {
  intro: "calm",
  outro: "calm",
  bridge: "calm",
  break: "calm",
  verse: "main",
  section: "main",
  chorus: "full",
  drop: "full",
};

/** Minimum length of a scene when it follows the mood, in bars. */
export const MIN_EMOTION_BARS = 2;
/** How many motif layers can play at once. */
export const MAX_MOTIFS = 2;

function barLengthMs(a: Analysis): number {
  return a.audio.tempo > 0 ? (60000 / a.audio.tempo) * (a.audio.beatsPerBar || 4) : 2000;
}

function beatLengthMs(a: Analysis): number {
  return a.audio.tempo > 0 ? 60000 / a.audio.tempo : 500;
}

function nearestDownbeat(a: Analysis, t: number, barMs: number): number {
  let best = t;
  let bestD = Infinity;
  for (const d of a.audio.downbeats) {
    const dd = Math.abs(d - t);
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
    if (d > t + barMs) break;
  }
  return bestD <= barMs ? best : t;
}

/** The scene id to use, falling back to "main", then the first scene. */
export function sceneOrFallback(show: Show, id: string): string {
  if (show.scenes.some((s) => s.id === id)) return id;
  if (show.scenes.some((s) => s.id === "main")) return "main";
  return show.scenes[0]?.id ?? "main";
}

/** True when a build-up (lift) was happening in the four bars before t. */
function liftBefore(a: Analysis, t: number, barMs: number): boolean {
  return a.eventsBetween("lift", t - 4 * barMs, t + barMs / 2).length > 0;
}

function dropAt(a: Analysis, t: number, barMs: number): boolean {
  return a.eventsBetween("drop", t - barMs / 2, t + barMs).length > 0;
}

function transitionFor(a: Analysis, show: Show, s: Section, start: number, barMs: number): Transition {
  const rules = show.director?.transitions;
  const explicit = rules?.[s.label];
  if (explicit) return explicit;
  if (s.label === "drop" || dropAt(a, start, barMs)) return rules?.drop ?? { kind: "flash", ms: Math.round(barMs / 2) };
  if (s.label === "chorus" && liftBefore(a, start, barMs)) return rules?.chorusAfterLift ?? { kind: "zoom", ms: Math.round(barMs) };
  return { kind: "crossfade", ms: Math.round(barMs) };
}

function sectionTimeline(a: Analysis, show: Show): TimelineEntry[] {
  const barMs = barLengthMs(a);
  const rules = show.director;
  const sections: Section[] = a.audio.sections.length > 0 ? a.audio.sections : [{ startMs: 0, endMs: a.durationMs, label: "section", group: "A", energy: 0.5 }];
  const out: TimelineEntry[] = [];
  for (const [i, s] of sections.entries()) {
    const sceneId = sceneOrFallback(show, rules?.sceneFor?.[s.label] ?? DEFAULT_SCENE_FOR[s.label]);
    const start = i === 0 ? 0 : nearestDownbeat(a, s.startMs, barMs);
    const prev = out[out.length - 1];
    if (prev && prev.sceneId === sceneId) {
      prev.endMs = s.endMs; // same scene continues: no transition
      continue;
    }
    if (prev) prev.endMs = start;
    out.push({ startMs: start, endMs: s.endMs, sceneId, transition: i === 0 ? { kind: "cut", ms: 0 } : transitionFor(a, show, s, start, barMs) });
  }
  const last = out[out.length - 1];
  if (last) last.endMs = Math.max(last.endMs, a.durationMs);
  return out;
}

/** Scene for a mood keyframe: the preset's map, else by the mood's energy. */
function sceneForMood(show: Show, emotion: Emotion, energy: number): string {
  const mapped = show.director?.sceneForEmotion?.[emotion];
  if (mapped) return sceneOrFallback(show, mapped);
  return sceneOrFallback(show, energy < 0.35 ? "calm" : energy < 0.7 ? "main" : "full");
}

function emotionTimeline(a: Analysis, show: Show): TimelineEntry[] | null {
  const keys = a.text?.mood ?? [];
  if (keys.length === 0) return null;
  const barMs = barLengthMs(a);
  const minMs = MIN_EMOTION_BARS * barMs;
  const out: TimelineEntry[] = [];
  const first = keys[0];
  if (!first) return null;
  out.push({ startMs: 0, endMs: a.durationMs, sceneId: sceneForMood(show, first.emotion, first.energy), transition: { kind: "cut", ms: 0 } });
  for (const k of keys.slice(1)) {
    const sceneId = sceneForMood(show, k.emotion, k.energy);
    const last = out[out.length - 1] as TimelineEntry;
    if (sceneId === last.sceneId) continue;
    const start = nearestDownbeat(a, k.ms, barMs);
    if (start - last.startMs < minMs || a.durationMs - start < minMs) continue;
    last.endMs = start;
    out.push({ startMs: start, endMs: a.durationMs, sceneId, transition: show.director?.transitions?.section ?? { kind: "crossfade", ms: Math.round(barMs) } });
  }
  return out;
}

export function autoTimeline(a: Analysis, show: Show): TimelineEntry[] {
  if (show.director?.follow === "emotion") {
    const byMood = emotionTimeline(a, show);
    if (byMood) return byMood;
  }
  return sectionTimeline(a, show);
}

/** The entries in effect: manual entries, or the auto timeline. */
export function timelineFor(a: Analysis, show: Show): TimelineEntry[] {
  return show.timeline.mode === "manual" && show.timeline.entries.length > 0 ? show.timeline.entries : autoTimeline(a, show);
}

export interface ActiveScenes {
  current: TimelineEntry;
  /** During a transition: the outgoing entry and progress 0..1 of the incoming one. */
  previous: TimelineEntry | null;
  mix: number;
}

export function activeAt(entries: TimelineEntry[], tMs: number): ActiveScenes | null {
  if (entries.length === 0) return null;
  let i = 0;
  for (let k = 0; k < entries.length; k++) if ((entries[k] as TimelineEntry).startMs <= tMs) i = k;
  const cur = entries[i] as TimelineEntry;
  const prev = i > 0 ? (entries[i - 1] as TimelineEntry) : null;
  const ms = cur.transition.ms;
  if (prev && cur.transition.kind !== "cut" && ms > 0 && tMs < cur.startMs + ms) {
    return { current: cur, previous: prev, mix: Math.max(0, (tMs - cur.startMs) / ms) };
  }
  return { current: cur, previous: null, mix: 1 };
}

// ---- Motifs ----

export interface MotifWindow {
  motif: Motif;
  /** One beat before the line. */
  startMs: number;
  /** The line's end plus one bar. */
  endMs: number;
  lineIndex: number;
}

export interface ActiveMotif {
  motif: Motif;
  startMs: number;
  endMs: number;
  /** A ready `motif` layer: the engine draws it on top of the scene. Its id is stable per motif. */
  layer: LayerConfig;
}

const windowCache = new WeakMap<Analysis, MotifWindow[]>();

/** Every motif window of a song, ordered by start (cached per analysis). */
export function motifWindows(a: Analysis): MotifWindow[] {
  const hit = windowCache.get(a);
  if (hit) return hit;
  const beat = beatLengthMs(a);
  const bar = barLengthMs(a);
  const out: MotifWindow[] = [];
  const lines: TextLine[] = a.text?.lines ?? [];
  for (const [i, line] of lines.entries()) {
    for (const motif of line.meaning?.motifs ?? []) out.push({ motif, startMs: Math.max(0, line.startMs - beat), endMs: line.endMs + bar, lineIndex: i });
  }
  out.sort((x, y) => x.startMs - y.startMs || x.lineIndex - y.lineIndex);
  windowCache.set(a, out);
  return out;
}

/** Fades in over a beat and out over the last bar of a window. */
function motifAmount(w: MotifWindow, tMs: number, beat: number, bar: number): number {
  const fin = Math.min(1, (tMs - w.startMs) / Math.max(1, beat));
  const fout = Math.min(1, (w.endMs - tMs) / Math.max(1, bar));
  const e = Math.max(0, Math.min(fin, fout));
  return e * e * (3 - 2 * e);
}

/**
 * The motifs to draw at tMs (empty when the show has motifs off). At most two
 * at once; when more are asked for, the newest windows win.
 */
export function motifsAt(a: Analysis, show: Show, tMs: number): ActiveMotif[] {
  if (!show.motifs) return [];
  const beat = beatLengthMs(a);
  const bar = barLengthMs(a);
  const live = motifWindows(a).filter((w) => tMs >= w.startMs && tMs < w.endMs);
  if (live.length === 0) return [];
  // Newest first, one window per motif.
  const newest = [...live].sort((x, y) => y.startMs - x.startMs || y.lineIndex - x.lineIndex);
  const picked: MotifWindow[] = [];
  for (const w of newest) {
    if (picked.length >= MAX_MOTIFS) break;
    if (picked.some((p) => p.motif === w.motif)) continue;
    picked.push(w);
  }
  return picked.map((w) => ({
    motif: w.motif,
    startMs: w.startMs,
    endMs: w.endMs,
    layer: { id: `motif-${w.motif}`, type: "motif", enabled: true, blend: "add", opacity: 1, params: { motif: w.motif, amount: Math.round(motifAmount(w, tMs, beat, bar) * 0.9 * 1000) / 1000, intensity: 0.85 } },
  }));
}
