/**
 * The director (SPEC.md §6.9): which scene plays when. Auto mode maps each
 * section to a scene with a transition on the nearest downbeat; manual mode
 * uses the show's entries. Motif insertion and the emotion-following mode
 * are PR1's.
 */
import type { Analysis } from "./analysis";
import type { SectionLabel, Show, TimelineEntry, Transition } from "./types";

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

export function autoTimeline(a: Analysis, show: Show): TimelineEntry[] {
  const barMs = a.audio.tempo > 0 ? (60000 / a.audio.tempo) * (a.audio.beatsPerBar || 4) : 2000;
  const rules = show.director;
  const sections = a.audio.sections.length > 0 ? a.audio.sections : [{ startMs: 0, endMs: a.durationMs, label: "section" as SectionLabel, group: "A", energy: 0.5 }];
  const out: TimelineEntry[] = [];
  for (const [i, s] of sections.entries()) {
    const sceneId = sceneOrFallback(show, rules?.sceneFor?.[s.label] ?? DEFAULT_SCENE_FOR[s.label]);
    const start = i === 0 ? 0 : nearestDownbeat(a, s.startMs, barMs);
    const transition: Transition = rules?.transitions?.[s.label] ?? (s.label === "drop" ? { kind: "flash", ms: Math.round(barMs / 2) } : { kind: "crossfade", ms: Math.round(barMs) });
    const prev = out[out.length - 1];
    if (prev && prev.sceneId === sceneId) {
      prev.endMs = s.endMs; // same scene continues: no transition
      continue;
    }
    if (prev) prev.endMs = start;
    out.push({ startMs: start, endMs: s.endMs, sceneId, transition: i === 0 ? { kind: "cut", ms: 0 } : transition });
  }
  const last = out[out.length - 1];
  if (last) last.endMs = Math.max(last.endMs, a.durationMs);
  return out;
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
