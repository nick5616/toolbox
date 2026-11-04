/**
 * Pure marker-editing and lane-drawing logic for the lanes panel (SPEC §5.6,
 * §14.4). No React: everything returns a new project or a plain value.
 */
import type { EditCustomMarker, EditMarkerRow } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { NormalProject } from "@/viz/edit/defaults";
import { LANE_DEFAULTS, laneSettings } from "@/viz/edit/defaults";
import { MAX_CUSTOM_MARKERS, nearestBeat } from "@/viz/edit/markers";
import type { LaneSettings, Marker, MarkerLane } from "@/viz/edit/types";
import { msToX } from "../geometry";
import { newId } from "../doc";

/** Go validation limits on the marker overrides. */
export const MAX_HIDDEN = 5000;
export const MAX_MOVED = 5000;
export const MAX_LABEL = 40;
export const MAX_SECTION_LABEL = 24;
/** Drag snap distance to a beat, and the T double-tap windows (§5.6). */
export const BEAT_SNAP_MS = 40;
export const DOUBLE_TAP_MS = 250;
export const DOUBLE_TAP_REACH_MS = 150;
/** Markers closer than this many pixels to the pointer are hit. */
export const HIT_PX = 6;

export const LANE_LABELS: Readonly<Record<MarkerLane, string>> = {
  beat: "Beats",
  downbeat: "Downbeats",
  kick: "Kick",
  snare: "Snare",
  hats: "Hi-hats",
  bass: "Bass",
  vocals: "Vocals",
  other: "Other",
  section: "Sections",
  drop: "Drops",
  lift: "Lifts",
  break: "Breaks",
  stop: "Stops",
  phrase: "Phrases",
  word: "Words",
  custom: "Custom",
  accent: "Accents",
};

/** Lanes drawn as ranges. */
export const RANGED_LANES: ReadonlySet<MarkerLane> = new Set<MarkerLane>(["section", "stop", "phrase", "word"]);

export const isRanged = (m: Marker): boolean => RANGED_LANES.has(m.lane) && m.endMs !== undefined;

// ---- document edits ----

/** Replaces one lane's settings. */
export function withLane(p: NormalProject, lane: MarkerLane, patch: Partial<LaneSettings>): NormalProject {
  const cur = laneSettings(p.markers, lane);
  return { ...p, markers: { ...p.markers, lanes: { ...p.markers.lanes, [lane]: { ...cur, ...patch } } } };
}

/** Clears a lane's overrides (hidden and moved ids, renamed sections). */
export function resetLaneOverrides(p: NormalProject, lane: MarkerLane): NormalProject {
  const prefix = `${lane}:`;
  const m = p.markers;
  const hidden = m.hidden.filter((id) => !id.startsWith(prefix));
  const moved = Object.fromEntries(Object.entries(m.moved).filter(([id]) => !id.startsWith(prefix)));
  const labels = Object.fromEntries(Object.entries(m.labels).filter(([id]) => !id.startsWith(prefix)));
  if (hidden.length === m.hidden.length && Object.keys(moved).length === Object.keys(m.moved).length && Object.keys(labels).length === Object.keys(m.labels).length) return p;
  return { ...p, markers: { ...m, hidden, moved, labels } };
}

/** A lane's settings back to the defaults. */
export function resetLaneSettings(p: NormalProject, lane: MarkerLane): NormalProject {
  return { ...p, markers: { ...p.markers, lanes: { ...p.markers.lanes, [lane]: { ...LANE_DEFAULTS[lane] } } } };
}

/** The song ms of a timeline-ms marker. */
export const songMsOf = (p: NormalProject, timelineMs: number): number => (p.song?.startMs ?? 0) + timelineMs;

/** Snaps a song ms to the nearest beat within 40 ms (unless disabled). */
export function snapSongMs(a: Analysis, songMs: number, snap: boolean): number {
  if (!snap) return Math.round(songMs);
  const b = nearestBeat(a, songMs);
  return b && Math.abs(b.ms - songMs) <= BEAT_SNAP_MS ? b.ms : Math.round(songMs);
}

/**
 * Moves a marker to a song ms: a custom marker's own ms, or a derived marker's
 * `moved` override. Returns the same project when nothing can change.
 */
export function moveMarker(p: NormalProject, m: Marker, toSongMs: number): NormalProject {
  const to = Math.round(Math.max(0, toSongMs));
  if (m.lane === "custom") {
    const i = p.markers.custom.findIndex((c) => c.id === m.id);
    const cur = p.markers.custom[i];
    if (!cur || cur.ms === to) return p;
    const custom = p.markers.custom.slice();
    custom[i] = { ...cur, ms: to };
    return { ...p, markers: { ...p.markers, custom } };
  }
  if (p.markers.moved[m.id] === to) return p;
  if (!(m.id in p.markers.moved) && Object.keys(p.markers.moved).length >= MAX_MOVED) return p;
  return { ...p, markers: { ...p.markers, moved: { ...p.markers.moved, [m.id]: to } } };
}

export interface DeleteResult {
  project: NormalProject;
  removed: number;
  hidden: number;
  /** Some were not hidden: the hidden list is full. */
  full: boolean;
}

/** Delete: custom markers are removed, derived markers are hidden. */
export function deleteMarkers(p: NormalProject, markers: readonly Marker[]): DeleteResult {
  const customIds = new Set(markers.filter((m) => m.lane === "custom").map((m) => m.id));
  const hidden = p.markers.hidden.slice();
  const have = new Set(hidden);
  let hid = 0;
  let full = false;
  for (const m of markers) {
    if (m.lane === "custom" || have.has(m.id)) continue;
    if (hidden.length >= MAX_HIDDEN) {
      full = true;
      continue;
    }
    hidden.push(m.id);
    have.add(m.id);
    hid++;
  }
  const custom = customIds.size ? p.markers.custom.filter((c) => !customIds.has(c.id)) : p.markers.custom;
  const removed = p.markers.custom.length - custom.length;
  if (!removed && !hid) return { project: p, removed: 0, hidden: 0, full };
  return { project: { ...p, markers: { ...p.markers, hidden: hid ? hidden : p.markers.hidden, custom } }, removed, hidden: hid, full };
}

/** Adds a custom marker at a song ms (null at the cap or outside the song range). */
export function addCustomMarker(p: NormalProject, songMs: number, label = ""): { project: NormalProject; id: string } | null {
  if (!p.song || p.markers.custom.length >= MAX_CUSTOM_MARKERS) return null;
  const ms = Math.round(songMs);
  if (ms < p.song.startMs || ms >= p.song.endMs) return null;
  const id = newId("k");
  const marker: EditCustomMarker = { id, ms, label: label.slice(0, MAX_LABEL) };
  return { project: { ...p, markers: { ...p.markers, custom: [...p.markers.custom, marker] } }, id };
}

/** Renames a custom marker. */
export function renameCustomMarker(p: NormalProject, id: string, label: string): NormalProject {
  const i = p.markers.custom.findIndex((c) => c.id === id);
  const cur = p.markers.custom[i];
  const next = label.trim().slice(0, MAX_LABEL);
  if (!cur || cur.label === next) return p;
  const custom = p.markers.custom.slice();
  custom[i] = { ...cur, label: next };
  return { ...p, markers: { ...p.markers, custom } };
}

/** Renames a section ("" clears the rename). */
export function renameSection(p: NormalProject, id: string, label: string): NormalProject {
  const next = label.trim().slice(0, MAX_SECTION_LABEL);
  const labels = { ...p.markers.labels };
  if (next) labels[id] = next;
  else delete labels[id];
  return { ...p, markers: { ...p.markers, labels } };
}

/** The custom marker nearest a song ms within `reach` ms (null if none). */
export function nearestCustom(p: NormalProject, songMs: number, reach = DOUBLE_TAP_REACH_MS): EditCustomMarker | null {
  let best: EditCustomMarker | null = null;
  let bestD = Infinity;
  for (const c of p.markers.custom) {
    const d = Math.abs(c.ms - songMs);
    if (d <= reach && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Removes one custom marker by id. */
export function removeCustom(p: NormalProject, id: string): NormalProject {
  const custom = p.markers.custom.filter((c) => c.id !== id);
  return custom.length === p.markers.custom.length ? p : { ...p, markers: { ...p.markers, custom } };
}

/** A tap: one custom marker, or (a second tap inside 250 ms) removal of the nearest one. */
export interface TapState {
  lastAt: number;
}

export type TapResult = { kind: "added"; project: NormalProject; id: string } | { kind: "deleted"; project: NormalProject } | { kind: "none" } | { kind: "full" };

export function tap(p: NormalProject, state: TapState, nowMs: number, songMs: number): TapResult {
  if (nowMs - state.lastAt < DOUBLE_TAP_MS) {
    state.lastAt = -Infinity;
    const hit = nearestCustom(p, songMs);
    return hit ? { kind: "deleted", project: removeCustom(p, hit.id) } : { kind: "none" };
  }
  state.lastAt = nowMs;
  if (p.markers.custom.length >= MAX_CUSTOM_MARKERS) return { kind: "full" };
  const added = addCustomMarker(p, songMs);
  return added ? { kind: "added", project: added.project, id: added.id } : { kind: "none" };
}

// ---- hit testing and visible window ----

/** Markers touching the window [fromMs, toMs] (timeline ms). */
export function visibleMarkers(list: readonly Marker[], fromMs: number, toMs: number): Marker[] {
  return list.filter((m) => (m.endMs !== undefined && RANGED_LANES.has(m.lane) ? m.endMs >= fromMs && m.ms <= toMs : m.ms >= fromMs && m.ms <= toMs));
}

/**
 * The marker under x (px in the time area): the nearest start tick within
 * HIT_PX, else a range containing x (the narrowest wins).
 */
export function hitTest(list: readonly Marker[], x: number, pps: number, scrollMs: number): Marker | null {
  let best: Marker | null = null;
  let bestD = HIT_PX + 0.001;
  for (const m of list) {
    const d = Math.abs(msToX(m.ms, pps, scrollMs) - x);
    if (d < bestD) {
      best = m;
      bestD = d;
    }
  }
  if (best) return best;
  let narrow: Marker | null = null;
  let narrowW = Infinity;
  for (const m of list) {
    if (!isRanged(m)) continue;
    const x0 = msToX(m.ms, pps, scrollMs);
    const x1 = msToX(m.endMs as number, pps, scrollMs);
    if (x >= x0 && x <= x1 && x1 - x0 < narrowW) {
      narrow = m;
      narrowW = x1 - x0;
    }
  }
  return narrow;
}

/** "lane · m:ss.mmm · 0.85" plus the label. */
export function describeMarker(m: Marker, formatMs: (ms: number) => string): string {
  const parts = [LANE_LABELS[m.lane], formatMs(m.ms), m.strength.toFixed(2)];
  if (m.label) parts.push(m.label);
  return parts.join(" · ");
}

/** Groups markers by lane (lists keep their order). */
export function groupByLane(markers: readonly Marker[]): Map<MarkerLane, Marker[]> {
  const out = new Map<MarkerLane, Marker[]>();
  for (const m of markers) {
    const l = out.get(m.lane);
    if (l) l.push(m);
    else out.set(m.lane, [m]);
  }
  return out;
}

// ---- export ----

/** Index of the last beat at or before a song ms, or -1. */
function beatIndexAt(a: Analysis, songMs: number): number {
  const b = a.audio.beats;
  let lo = 0;
  let hi = b.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((b[mid] as number) <= songMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * The rows of a markers file (§5.6): visible lanes only, in the markers'
 * (ms, lane) order. `end_ms` is timeline ms (0 = a point); `beat` is the index
 * of the last beat at or before the marker (−1 before the first).
 */
export function buildMarkerRows(markers: readonly Marker[], p: NormalProject, a: Analysis): EditMarkerRow[] {
  const start = p.song?.startMs ?? 0;
  const rows: EditMarkerRow[] = [];
  for (const m of markers) {
    if (!laneSettings(p.markers, m.lane).visible) continue;
    const songMs = Math.round(m.ms + start);
    rows.push({
      lane: m.lane,
      timelineMs: Math.round(m.ms),
      songMs,
      endMs: m.endMs !== undefined ? Math.round(m.endMs) : 0,
      strength: Math.round(m.strength * 1000) / 1000,
      label: m.label ?? "",
      bar: m.bar ?? -1,
      beat: m.beatIndex ?? beatIndexAt(a, songMs),
    });
  }
  return rows;
}
