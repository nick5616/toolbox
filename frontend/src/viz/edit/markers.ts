/**
 * Marker derivation (Phase 9 SPEC §5). Pure and deterministic: the UI and the
 * export worker call it with the same inputs, so marker signals in an export
 * match the preview. No React, no Wails.
 *
 * Everything is derived on the whole song (so `every`, first-of-bar and bar
 * indices never depend on the range), then clipped to the range.
 */
import type { EditMarkerState } from "@/lib/api";
import type { Analysis, Event2, Section } from "../analysis";
import { LANE_DEFAULTS, laneSettings } from "./defaults";
import { MARKER_LANES, type LaneSettings, type Marker, type MarkerLane, type SongRange } from "./types";

/** Fixed tap latency subtracted from tapped markers (§5.6). */
export const TAP_LATENCY_MS = 40;

/** Custom markers are capped here (§5.6). */
export const MAX_CUSTOM_MARKERS = 2000;

const LANE_ORDER = new Map<MarkerLane, number>(MARKER_LANES.map((l, i) => [l, i]));

/** A marker before filters and overrides (song ms). */
interface Raw {
  ms: number;
  endMs?: number;
  strength: number;
  label?: string;
  beatIndex?: number;
  bar: number;
}

/** The bar structure of an analysis for a bar offset. */
export interface BarGrid {
  /** Song ms of every bar start (downbeats after the offset). */
  starts: number[];
  /** Index into audio.beats of every bar start. */
  startIndex: number[];
  /** Beats per bar. */
  perBar: number;
  /** The phase used: the beat index (mod perBar) where bars start. */
  phase: number;
}

function perBar(a: Analysis): number {
  const n = Math.round(a.audio.beatsPerBar);
  return n >= 1 ? n : 4;
}

/** The beat grid of an analysis, completed where the tracker found no beats. */
export interface BeatGrid {
  /** Song ms of every beat, sorted. */
  times: number[];
  /** Indices of beats that were filled in (before the first, after the last, inside long gaps). */
  estimated: ReadonlySet<number>;
}

const gridCache = new WeakMap<Analysis, BeatGrid>();

/**
 * The tracker often finds no beats in a quiet intro, an outro or a breakdown
 * (librosa needs onsets). Edits still cut there, so the grid is continued at
 * the median beat period: back to 0, on to the end of the song, and through
 * gaps longer than 1.75 periods. Filled beats are marked estimated.
 */
export function beatGrid(a: Analysis): BeatGrid {
  const hit = gridCache.get(a);
  if (hit) return hit;
  const src = a.audio.beats;
  let out: BeatGrid;
  if (src.length < 2) out = { times: [...src], estimated: new Set() };
  else {
    const diffs: number[] = [];
    for (let i = 1; i < src.length; i++) diffs.push((src[i] as number) - (src[i - 1] as number));
    diffs.sort((x, y) => x - y);
    const period = diffs[diffs.length >> 1] as number;
    const times: number[] = [];
    const est = new Set<number>();
    if (period >= 200 && period <= 2000) {
      const before: number[] = [];
      for (let t = (src[0] as number) - period; t >= -period * 0.25; t -= period) before.unshift(Math.max(0, Math.round(t)));
      for (const t of before) {
        est.add(times.length);
        times.push(t);
      }
      for (let i = 0; i < src.length; i++) {
        const t = src[i] as number;
        if (i > 0) {
          const prev = src[i - 1] as number;
          const gap = t - prev;
          if (gap > period * 1.75) {
            const n = Math.round(gap / period);
            for (let k = 1; k < n; k++) {
              est.add(times.length);
              times.push(Math.round(prev + (gap * k) / n));
            }
          }
        }
        times.push(t);
      }
      for (let t = (src[src.length - 1] as number) + period; t < a.durationMs - period * 0.25; t += period) {
        est.add(times.length);
        times.push(Math.round(t));
      }
      // Rounding can collide at 0: keep times strictly increasing.
      for (let i = times.length - 1; i > 0; i--) if ((times[i] as number) <= (times[i - 1] as number)) times.splice(i - 1, 1);
    } else times.push(...src);
    out = { times, estimated: est };
  }
  gridCache.set(a, out);
  return out;
}

/** The median beat period in ms (0 without beats). */
export function beatPeriod(a: Analysis): number {
  const t = beatGrid(a).times;
  if (t.length < 2) return 0;
  const d: number[] = [];
  for (let i = 1; i < t.length; i++) d.push((t[i] as number) - (t[i - 1] as number));
  d.sort((x, y) => x - y);
  return d[d.length >> 1] as number;
}

/** The analysis's own phase p: the index of its first downbeat in the beat grid (mod beats per bar). */
export function analysisPhase(a: Analysis): number {
  const first = a.audio.downbeats[0];
  const n = perBar(a);
  if (first === undefined) return 0;
  const beats = beatGrid(a).times;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs((beats[i] as number) - first);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    if ((beats[i] as number) > first) break;
  }
  return best % n;
}

/** Downbeats with the bar offset applied (§5.4). */
export function barGrid(a: Analysis, barOffset: number): BarGrid {
  const n = perBar(a);
  const phase = (analysisPhase(a) + (((barOffset % n) + n) % n)) % n;
  const starts: number[] = [];
  const startIndex: number[] = [];
  const beats = beatGrid(a).times;
  for (let i = phase; i < beats.length; i += n) {
    starts.push(beats[i] as number);
    startIndex.push(i);
  }
  return { starts, startIndex, perBar: n, phase };
}

/** Index of the last element ≤ t, or −1. */
function lastAtOrBefore(arr: readonly number[], t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 0-based bar index of a song ms (−1 before the first downbeat). */
export function barOf(grid: BarGrid, songMs: number): number {
  return lastAtOrBefore(grid.starts, songMs);
}

/** The beat nearest to a song ms, or null without beats. */
export function nearestBeat(a: Analysis, songMs: number): { ms: number; index: number } | null {
  const b = beatGrid(a).times;
  if (!b.length) return null;
  const i = lastAtOrBefore(b, songMs);
  const lo = i < 0 ? 0 : i;
  const hi = Math.min(b.length - 1, lo + 1);
  const d0 = Math.abs((b[lo] as number) - songMs);
  const d1 = Math.abs((b[hi] as number) - songMs);
  return d1 < d0 ? { ms: b[hi] as number, index: hi } : { ms: b[lo] as number, index: lo };
}

// ---- lane sources ----

const EVENT_LANES: Partial<Record<MarkerLane, string>> = {
  kick: "kick",
  snare: "snare",
  hats: "hats",
  bass: "bass",
  vocals: "vocals",
  other: "other",
  drop: "drop",
  lift: "lift",
  break: "break",
};

const CURVE: Partial<Record<MarkerLane, string>> = { kick: "drums.kick", snare: "drums.snare", hats: "drums.hats" };

function fromEvents(a: Analysis, id: string, grid: BarGrid): Raw[] {
  return a.events(id).map((e: Event2) => ({ ms: e[0], strength: e[1] / 255, bar: barOf(grid, e[0]) }));
}

/** Peak-picks a drum curve (§5.3). */
function pickPeaks(v: Float32Array, fps: number, minStrength: number, grid: BarGrid): Raw[] {
  const kept: Raw[] = [];
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const x = v[i] as number;
    if (x < minStrength || x <= 0) continue;
    let peak = true;
    for (let j = Math.max(0, i - 2); j < i && peak; j++) if ((v[j] as number) >= x) peak = false;
    for (let j = i + 1; j <= Math.min(n - 1, i + 2) && peak; j++) if ((v[j] as number) > x) peak = false;
    if (!peak) continue;
    const before = i >= 3 ? (v[i - 3] as number) : 0;
    if (x - before < 0.05) continue;
    const ms = Math.round((i * 1000) / fps);
    const cand: Raw = { ms, strength: x, bar: barOf(grid, ms) };
    // At least 80 ms after the previous kept peak: the stronger one wins.
    let dropped = false;
    for (;;) {
      const last = kept[kept.length - 1];
      if (!last || ms - last.ms >= 80) break;
      if (last.strength >= x) {
        dropped = true;
        break;
      }
      kept.pop();
    }
    if (!dropped) kept.push(cand);
  }
  return kept;
}

/** Stops: sudden near-silence in mix.level (§5.3). */
function deriveStops(a: Analysis, grid: BarGrid): Raw[] {
  const L = a.channel("mix.level");
  if (!L) return [];
  const fps = a.fps;
  const n = L.length;
  const win = Math.max(1, Math.round(2 * fps));
  const hold = Math.max(1, Math.ceil(0.15 * fps));
  const period = beatPeriod(a);
  const out: Raw[] = [];
  // Sliding maximum of the previous 2 s: a cheap necessary condition (the median is <= the maximum).
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let skipTo = 0;
  let lastBeat = -2;
  const scratch = new Float32Array(win);
  for (let i = 0; i < n; i++) {
    // window = [i-win, i-1]
    if (i >= 1) {
      while (tail > head && (L[dq[tail - 1] as number] as number) <= (L[i - 1] as number)) tail--;
      dq[tail++] = i - 1;
    }
    while (head < tail && (dq[head] as number) < i - win) head++;
    if (i < skipTo || i < 1) continue;
    const x = L[i] as number;
    const maxPrev = head < tail ? (L[dq[head] as number] as number) : 0;
    if (maxPrev < 0.15 || x >= 0.35 * maxPrev) continue;
    const startMs = Math.round((i * 1000) / fps);
    if (startMs < 500 || startMs > a.durationMs - 500) continue;
    const from = Math.max(0, i - win);
    const len = i - from;
    for (let j = 0; j < len; j++) scratch[j] = L[from + j] as number;
    const sorted = scratch.subarray(0, len).sort();
    const ref = len % 2 ? (sorted[(len - 1) >> 1] as number) : (((sorted[len / 2 - 1] as number) + (sorted[len / 2] as number)) / 2);
    if (ref < 0.15) continue;
    // L must stay below 0.35·ref for ≥ 150 ms.
    let ok = true;
    for (let j = i; j < Math.min(n, i + hold); j++) {
      if ((L[j] as number) >= 0.35 * ref) {
        ok = false;
        break;
      }
    }
    if (!ok || i + hold > n) continue;
    const beatIdx = lastAtOrBefore(beatGrid(a).times, startMs);
    // The end: L is back at 0.5·ref, or 2 s.
    let end = i + hold;
    let minL = Infinity;
    let back = false;
    for (let j = i; j < Math.min(n, i + win); j++) {
      if ((L[j] as number) >= 0.5 * ref) {
        end = j;
        back = true;
        break;
      }
      end = j + 1;
    }
    // Music that never comes back is an ending (or a fade), not a stop.
    if (!back) {
      skipTo = Math.max(end, i + 1);
      continue;
    }
    for (let j = i; j < end; j++) minL = Math.min(minL, L[j] as number);
    skipTo = Math.max(end, i + 1);
    // A stop (beat cut) silences most of a beat and starts on the beat. Shorter
    // dips between hits (side-chain pumping, re-attacked pads) aren't stops.
    const endMs = Math.round((end * 1000) / fps);
    if (period > 0) {
      if (endMs - startMs < Math.max(150, 0.6 * period)) continue;
      const near = nearestBeat(a, startMs);
      if (near && (startMs - near.ms < -60 || startMs - near.ms > 150)) continue;
    }
    if (beatIdx >= 0 && beatIdx === lastBeat) continue;
    lastBeat = beatIdx;
    out.push({
      ms: startMs,
      endMs,
      strength: Math.max(0, Math.min(1, 1 - minL / ref)),
      bar: barOf(grid, startMs),
    });
  }
  return out;
}

/** Phrases: timed lines, or singing runs without text (§5.3). */
function derivePhrases(a: Analysis, grid: BarGrid): Raw[] {
  const lines = a.text?.lines ?? [];
  if (lines.length) {
    return lines.map((l) => ({ ms: l.startMs, endMs: l.endMs, strength: 1, label: l.text, bar: barOf(grid, l.startMs) }));
  }
  const V = a.channel("vocals.voiced");
  if (!V) return [];
  const fps = a.fps;
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= V.length; i++) {
    const on = i < V.length && (V[i] as number) > 0.5;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([(start * 1000) / fps, (i * 1000) / fps]);
      start = -1;
    }
  }
  const merged: Array<[number, number]> = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 300) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged
    .filter(([s, e]) => e - s >= 1000)
    .map(([s, e]) => ({ ms: Math.round(s), endMs: Math.round(e), strength: 1, bar: barOf(grid, Math.round(s)) }));
}

function deriveWords(a: Analysis, grid: BarGrid): Raw[] {
  const out: Raw[] = [];
  for (const l of a.text?.lines ?? []) {
    for (const w of l.words) out.push({ ms: w.startMs, endMs: w.endMs, strength: w.emphasis ? 1 : 0.7, label: w.text, bar: barOf(grid, w.startMs) });
  }
  return out;
}

function deriveSections(a: Analysis, grid: BarGrid): Raw[] {
  return a.audio.sections.map((s: Section) => ({ ms: s.startMs, endMs: s.endMs, strength: s.energy, label: s.label, bar: barOf(grid, s.startMs) }));
}

/** Mean of a channel over [t0, t1) song ms (0 when absent or empty). */
function meanOf(a: Analysis, ids: readonly string[], t0: number, t1: number): number {
  const fps = a.fps;
  const i0 = Math.max(0, Math.floor((t0 * fps) / 1000));
  const i1 = Math.min(a.frames, Math.ceil((t1 * fps) / 1000));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (const id of ids) {
    const ch = a.channel(id);
    if (!ch) continue;
    for (let i = i0; i < i1; i++) sum += ch[i] as number;
  }
  return sum / (i1 - i0);
}

/**
 * Drops: the analysis's own (a bar ≥ 6 dB louder than the two before), plus
 * the classic "stop, then the drop": a downbeat right after a stop where the
 * low end (sub + bass) comes back much stronger than in the bar before the
 * stop. A loud build-up often hides that second kind from the loudness rule.
 */
function deriveDrops(a: Analysis, grid: BarGrid): Raw[] {
  const out = fromEvents(a, "drop", grid);
  const stops = deriveStops(a, grid);
  if (!stops.length || !grid.starts.length) return out;
  const barMs = grid.starts.length > 1 ? ((grid.starts[grid.starts.length - 1] as number) - (grid.starts[0] as number)) / (grid.starts.length - 1) : 2000;
  // Cues that come back hard on a drop: the low end, or (with stems) the kick drum.
  const cues: Array<{ ids: string[]; min: number; ratio: number }> = [{ ids: a.has("mix.sub") ? ["mix.sub", "mix.bass"] : ["mix.level"], min: 0.25, ratio: 1.3 }];
  if (a.audio.stems && a.has("drums.kick")) cues.push({ ids: ["drums.kick"], min: 0.08, ratio: 1.8 });
  for (const st of stops) {
    const end = st.endMs ?? st.ms;
    const k = grid.starts.findIndex((d) => d >= st.ms);
    if (k < 0) continue;
    const d = grid.starts[k] as number;
    if (d - end > 250 || d < end - barMs / 2) continue;
    let ratio = 0;
    for (const cue of cues) {
      const before = meanOf(a, cue.ids, st.ms - barMs, st.ms);
      const after = meanOf(a, cue.ids, d, d + barMs);
      const r = after / Math.max(cue.ids.length * 0.02, before);
      if (after >= cue.min * cue.ids.length && r >= cue.ratio) ratio = Math.max(ratio, r);
    }
    if (ratio === 0) continue;
    if (out.some((e) => Math.abs(e.ms - d) < 500)) continue;
    out.push({ ms: d, strength: Math.max(0.5, Math.min(1, (ratio - 1) / 1.5)), bar: barOf(grid, d) });
  }
  return out.sort((x, y) => x.ms - y.ms);
}

/** Every marker of a derived lane before filters (song ms, whole song). */
function rawLane(a: Analysis, lane: MarkerLane, s: LaneSettings, grid: BarGrid): Raw[] {
  switch (lane) {
    case "beat": {
      const onBar = new Set(grid.startIndex);
      const bg = beatGrid(a);
      return bg.times.map((t, i) => ({ ms: t, strength: (onBar.has(i) ? 1 : 0.6) * (bg.estimated.has(i) ? 0.6 : 1), beatIndex: i, bar: barOf(grid, t) }));
    }
    case "downbeat": {
      const est = beatGrid(a).estimated;
      return grid.starts.map((t, k) => ({ ms: t, strength: est.has(grid.startIndex[k] as number) ? 0.7 : 1, beatIndex: grid.startIndex[k], bar: k }));
    }
    case "kick":
    case "snare":
    case "hats": {
      const curve = CURVE[lane];
      if (s.minStrength < 0.1 && a.audio.stems && curve) {
        const ch = a.channel(curve);
        if (ch) return pickPeaks(ch, a.fps, s.minStrength, grid);
      }
      return fromEvents(a, EVENT_LANES[lane] as string, grid);
    }
    case "drop":
      return deriveDrops(a, grid);
    case "bass":
    case "vocals":
    case "other":
    case "lift":
    case "break":
      return fromEvents(a, EVENT_LANES[lane] as string, grid);
    case "section":
      return deriveSections(a, grid);
    case "stop":
      return deriveStops(a, grid);
    case "phrase":
      return derivePhrases(a, grid);
    case "word":
      return deriveWords(a, grid);
    case "custom":
      return [];
  }
}

const idOf = (lane: MarkerLane, ms: number) => `${lane}:${ms}`;

function hasOwn(o: object | null | undefined, k: string): boolean {
  return !!o && Object.prototype.hasOwnProperty.call(o, k);
}

/** Context shared by the lanes of one derivation. */
interface Ctx {
  a: Analysis;
  state: EditMarkerState;
  range: SongRange;
  grid: BarGrid;
  hidden: ReadonlySet<string>;
}

function makeCtx(a: Analysis, state: EditMarkerState, range: SongRange): Ctx {
  return { a, state, range, grid: barGrid(a, state.barOffset ?? 0), hidden: new Set(state.hidden ?? []) };
}

function laneMarkers(c: Ctx, lane: MarkerLane, settings: LaneSettings): Marker[] {
  const { range, state } = c;
  const out: Marker[] = [];
  if (lane === "custom") {
    for (const m of state.custom ?? []) {
      if (m.ms < range.startMs || m.ms >= range.endMs) continue;
      const mk: Marker = { id: m.id, lane, ms: m.ms - range.startMs, strength: 1, bar: barOf(c.grid, m.ms) };
      if (m.label) mk.label = m.label;
      out.push(mk);
    }
    return out.sort((x, y) => x.ms - y.ms);
  }
  let list = rawLane(c.a, lane, settings, c.grid);
  // 1. strength
  if (settings.minStrength > 0) list = list.filter((r) => r.strength >= settings.minStrength);
  // 2. first of bar
  if (settings.firstOfBar) {
    const seen = new Set<number>();
    list = list.filter((r) => {
      if (seen.has(r.bar)) return false;
      seen.add(r.bar);
      return true;
    });
  }
  // 3. every Nth
  const every = Math.max(1, Math.round(settings.every));
  if (every > 1) list = list.filter((_, i) => i % every === 0);
  const ranged = lane === "section" || lane === "stop" || lane === "phrase" || lane === "word";
  for (const r of list) {
    const id = idOf(lane, r.ms);
    // 5. overrides
    if (c.hidden.has(id)) continue;
    let ms = r.ms + settings.nudgeMs; // 4. nudge
    let end = r.endMs === undefined ? undefined : r.endMs + settings.nudgeMs;
    let moved = false;
    if (hasOwn(state.moved, id)) {
      const to = (state.moved as Record<string, number>)[id] as number;
      end = r.endMs === undefined ? undefined : r.endMs + (to - r.ms); // moved: no nudge
      ms = to;
      moved = true;
    }
    // 6. range clip (ranged markers by overlap, clamped to the range)
    if (ranged && end !== undefined) {
      if (end <= range.startMs || ms >= range.endMs) continue;
    } else if (ms < range.startMs || ms >= range.endMs) continue;
    // 7. timeline ms
    const mk: Marker = { id, lane, ms: Math.max(range.startMs, ms) - range.startMs, strength: r.strength, bar: r.bar };
    if (end !== undefined) mk.endMs = Math.min(range.endMs, end) - range.startMs;
    const label = lane === "section" ? (state.labels?.[id] ?? r.label) : r.label;
    if (label) mk.label = label;
    if (r.beatIndex !== undefined) mk.beatIndex = r.beatIndex;
    if (moved) mk.moved = true;
    out.push(mk);
  }
  return out;
}

/**
 * Every lane's markers inside [range.startMs, range.endMs) (song ms), sorted by
 * (ms, lane), overrides applied; `ms` is timeline ms (songMs − range.startMs).
 * Ranged markers (section, stop, phrase, word) are kept when they overlap the
 * range and clamped to it; their ids keep the original song ms.
 */
export function deriveMarkers(a: Analysis, state: EditMarkerState, range: SongRange): Marker[] {
  const c = makeCtx(a, state, range);
  const all: Marker[] = [];
  for (const lane of MARKER_LANES) {
    const m = laneMarkers(c, lane, laneSettings(state, lane));
    for (const x of m) all.push(x);
  }
  return all.sort((x, y) => x.ms - y.ms || (LANE_ORDER.get(x.lane) as number) - (LANE_ORDER.get(y.lane) as number));
}

/**
 * One lane's markers, optionally with other settings than the project's (the
 * threshold slider's live count). Same rules and order as deriveMarkers.
 */
export function deriveLane(a: Analysis, state: EditMarkerState, lane: MarkerLane, range: SongRange, settings?: LaneSettings): Marker[] {
  return laneMarkers(makeCtx(a, state, range), lane, settings ?? laneSettings(state, lane));
}

/** The defaults of a lane (re-exported for the UI). */
export const laneDefaults = (lane: MarkerLane): LaneSettings => LANE_DEFAULTS[lane];
