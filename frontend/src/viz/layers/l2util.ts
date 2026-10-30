/**
 * Shared helpers for the L2 shape layers and the note highway: a multi-kind
 * SDF quad shader, palette ramps, spline sampling, and the pure logic behind
 * notes, peaks and pitch runs (unit-tested in l2.test.ts).
 */
import type { Analysis, Event2 } from "../analysis";
import type { QuadBatch } from "../gl/quads";
import { mixLinear, type ResolvedPalette } from "../palette";
import type { ParamSpec } from "./registry";

export const TAU = Math.PI * 2;
export const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------- colour ramps ----------

export const COLOR_OPTIONS = ["cycle", "c0", "c1", "c2", "c3", "accent"] as const;

/** A ramp of `steps` colours (linear RGB, flat) for a colour mode; "cycle" loops through the four palette colours. */
export function buildRamp(pal: ResolvedPalette, mode: string, steps = 24): Float32Array {
  const out = new Float32Array(steps * 3);
  const single = mode === "accent" ? pal.accent : mode === "c0" ? pal.colors[0] : mode === "c1" ? pal.colors[1] : mode === "c2" ? pal.colors[2] : mode === "c3" ? pal.colors[3] : null;
  for (let i = 0; i < steps; i++) {
    let c: readonly [number, number, number];
    if (single) c = single;
    else {
      const x = (i / steps) * 4;
      const k = Math.floor(x);
      c = mixLinear(pal.colors[(k % 4) as 0 | 1 | 2 | 3], pal.colors[((k + 1) % 4) as 0 | 1 | 2 | 3], x - k);
    }
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

/** Samples a ramp at x (wraps around), writing linear RGB into out. */
export function rampAt(ramp: Float32Array, x: number, out: number[]): void {
  const n = ramp.length / 3;
  const f = (((x % 1) + 1) % 1) * n;
  const i = Math.floor(f);
  const j = (i + 1) % n;
  const w = f - i;
  for (let c = 0; c < 3; c++) out[c] = (ramp[i * 3 + c] as number) + ((ramp[j * 3 + c] as number) - (ramp[i * 3 + c] as number)) * w;
}

// ---------- params ----------

/** The params every L2 layer shares (SPEC.md §6.7 common params). */
export function commonParams(o: { x?: number; y?: number; scale?: number; glow?: number; brightness?: number; color?: string } = {}): Record<string, ParamSpec> {
  return {
    x: { kind: "number", label: "Position X", min: 0, max: 1, default: o.x ?? 0.5 },
    y: { kind: "number", label: "Position Y", min: 0, max: 1, default: o.y ?? 0.5 },
    scale: { kind: "number", label: "Scale", min: 0.3, max: 2, default: o.scale ?? 1 },
    rotation: { kind: "number", label: "Rotation", min: -180, max: 180, default: 0, step: 1 },
    color: { kind: "enum", label: "Colour", options: COLOR_OPTIONS, default: o.color ?? "cycle" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: o.glow ?? 0.55 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: o.brightness ?? 1.5 },
  };
}

// ---------- sampling ----------

/** Catmull-Rom interpolation of arr at a fractional index (clamped at the ends). */
export function catmull(arr: ArrayLike<number>, x: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  const xi = clamp(x, 0, n - 1);
  const i = Math.floor(xi);
  const t = xi - i;
  const g = (k: number) => arr[Math.max(0, Math.min(n - 1, k))] as number;
  const p0 = g(i - 1);
  const p1 = g(i);
  const p2 = g(i + 1);
  const p3 = g(i + 2);
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Smoothly snaps x to the nearest integer: stays on integers except for a quick glide near the halfway points. */
export function snapSmooth(x: number): number {
  const k = Math.floor(x);
  const f = x - k;
  return k + smoothstep(0.62, 0.9, f);
}

/** Mirrored index 0..1: 0 at the middle of 0..1, 1 at both ends. */
export const mirrorU = (phi: number) => Math.abs(2 * (phi - Math.floor(phi)) - 1);

// ---------- multi-kind SDF quads ----------

/**
 * One shader for every shape the L2 layers draw. Kind in extra.z:
 * 0 rounded box (extra.y = corner radius), 1 ring (extra.y = thickness),
 * 2 soft disc (extra.y = falloff power), 3 disc. extra.w scales the glow (0 = 1).
 */
export const SHADE_MULTI = `
uniform float u_glow;
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float kind = extra.z;
  float d; float k = 0.6;
  if (kind < 0.5) { float r = min(min(h.x, h.y), extra.y); d = sdRoundBox(p, h, r); }
  else if (kind < 1.5) { d = abs(length(p) - min(h.x, h.y)) - extra.y * 0.5; k = 0.7; }
  else if (kind < 2.5) {
    float r = min(h.x, h.y);
    float x = clamp(length(p) / r, 0.0, 1.0);
    float a = pow(1.0 - x, max(extra.y, 0.1));
    return vec4(color.rgb * color.a * a, color.a * a);
  } else { d = sdCircle(p, min(h.x, h.y)); k = 0.7; }
  float gl = u_glow * (extra.w > 0.0 ? extra.w : 1.0);
  float a = aaFill(d) + glowFalloff(d, gl) * k;
  return vec4(color.rgb * color.a * a, color.a * a);
}`;

export function pushBox(b: QuadBatch, cx: number, cy: number, hw: number, hh: number, r: number, g: number, bl: number, a: number, rot = 0, radius = 1e6, glowScale = 0): void {
  b.push(cx, cy, hw, hh, r, g, bl, a, rot, radius, 0, glowScale);
}
export function pushRing(b: QuadBatch, cx: number, cy: number, radius: number, thick: number, r: number, g: number, bl: number, a: number, glowScale = 0): void {
  b.push(cx, cy, radius + thick, radius + thick, r, g, bl, a, 0, thick, 1, glowScale);
}
export function pushSoft(b: QuadBatch, cx: number, cy: number, radius: number, r: number, g: number, bl: number, a: number, power = 2): void {
  b.push(cx, cy, radius, radius, r, g, bl, a, 0, power, 2, 0);
}
export function pushDot(b: QuadBatch, cx: number, cy: number, radius: number, r: number, g: number, bl: number, a: number, glowScale = 0): void {
  b.push(cx, cy, radius, radius, r, g, bl, a, 0, 0, 3, glowScale);
}
/** A round-capped line segment of the given thickness. */
export function pushSeg(b: QuadBatch, x0: number, y0: number, x1: number, y1: number, thick: number, r: number, g: number, bl: number, a: number, glowScale = 0): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const ht = thick / 2;
  b.push((x0 + x1) / 2, (y0 + y1) / 2, len / 2 + ht, ht, r, g, bl, a, Math.atan2(dy, dx), ht, 0, glowScale);
}

// ---------- perspective ----------

/** Screen depth of a point `dt` seconds from the fret: 1 at the fret, → 0 at the horizon (hyperbolic, like a ground plane). */
export function hyperDepth(dt: number, k: number): number {
  return dt <= 0 ? 1 : 1 / (1 + dt * k);
}
/** Inverse of hyperDepth for s in (0, 1]. */
export function hyperTime(s: number, k: number): number {
  return s >= 1 ? 0 : (1 / s - 1) / k;
}

// ---------- notes ----------

export interface Note {
  /** Event time in ms: the moment the note reaches the fret. */
  t: number;
  /** 0..1 */
  s: number;
  /** Sustain length in ms (0 = a hit). */
  dur: number;
}

/** Local maxima of a channel in [t0, t1] ms above a threshold, at least minGapMs apart (strongest wins). */
export function pickPeaks(arr: ArrayLike<number>, fps: number, t0: number, t1: number, threshold: number, minGapMs: number): Array<{ t: number; s: number }> {
  const out: Array<{ t: number; s: number }> = [];
  const i0 = Math.max(1, Math.floor((t0 / 1000) * fps));
  const i1 = Math.min(arr.length - 2, Math.ceil((t1 / 1000) * fps));
  for (let i = i0; i <= i1; i++) {
    const v = arr[i] as number;
    if (v < threshold || v < (arr[i - 1] as number) || v <= (arr[i + 1] as number)) continue;
    // must stand out from the recent past (a real onset, not a plateau)
    const back = arr[Math.max(0, i - 4)] as number;
    if (v - back < 0.04) continue;
    const t = (i / fps) * 1000;
    const last = out[out.length - 1];
    if (last && t - last.t < minGapMs) {
      if (v > last.s) out[out.length - 1] = { t, s: v };
      continue;
    }
    out.push({ t, s: v });
  }
  return out;
}

/** How long (ms) a channel stays above `frac` of its value at tMs, capped at maxMs. */
export function sustainMs(arr: ArrayLike<number>, fps: number, tMs: number, maxMs: number, frac = 0.6): number {
  const i0 = Math.round((tMs / 1000) * fps);
  const ref = arr[Math.min(arr.length - 1, Math.max(0, i0))] as number;
  if (!(ref > 0.05)) return 0;
  const lim = Math.min(arr.length - 1, i0 + Math.round((maxMs / 1000) * fps));
  let i = i0;
  while (i < lim && (arr[i + 1] as number) >= ref * frac) i++;
  return ((i - i0) / fps) * 1000;
}

export interface LaneSource {
  /** Event list id (kick, snare, ...). */
  event: string;
  /** Used when the event list is empty (no stems): picked from this channel. */
  channel?: string;
  /** "held" = vocal held notes; a channel id = sustain while it stays high; undefined = no sustains. */
  sustain?: "held" | string;
  /** Peak-picking threshold for the channel fallback. */
  threshold?: number;
}

export const INSTRUMENT_LANES: readonly LaneSource[] = [
  { event: "kick", channel: "mix.sub", threshold: 0.3 },
  { event: "snare", channel: "mix.mid", threshold: 0.35 },
  { event: "hats", channel: "mix.brilliance", threshold: 0.3 },
  { event: "bass", channel: "mix.bass", sustain: "bass.level", threshold: 0.35 },
  { event: "vocals", channel: "mix.presence", sustain: "held", threshold: 0.35 },
];
export const BAND_LANES: readonly LaneSource[] = [
  { event: "", channel: "mix.bass", sustain: "mix.bass", threshold: 0.4 },
  { event: "", channel: "mix.lowmid", sustain: "mix.lowmid", threshold: 0.35 },
  { event: "", channel: "mix.mid", sustain: "mix.mid", threshold: 0.35 },
  { event: "", channel: "mix.presence", sustain: "mix.presence", threshold: 0.3 },
  { event: "", channel: "mix.brilliance", threshold: 0.3 },
];

/** Notes of one lane with time in (t0, t1]. Deterministic and stateless. */
export function laneNotes(a: Analysis, lane: LaneSource, t0: number, t1: number): Note[] {
  const out: Note[] = [];
  let hits: Array<[number, number]> = [];
  const ev = lane.event ? a.eventsBetween(lane.event, t0, t1) : [];
  if (lane.event && a.events(lane.event).length > 0) hits = ev.map((e: Event2) => [e[0], e[1] / 255]);
  else if (lane.channel) {
    const ch = a.channel(lane.channel);
    if (ch) hits = pickPeaks(ch, a.fps, t0, t1, lane.threshold ?? 0.35, 140).map((p) => [p.t, p.s]);
  }
  const sustainCh = lane.sustain && lane.sustain !== "held" ? a.channel(lane.sustain) : null;
  if (lane.sustain === "held") {
    // held notes are notes of their own (head at the start, tail until the end); hits inside them are swallowed
    const held = a.held().filter((h) => h[1] > t0 && h[0] <= t1);
    for (const h of held) out.push({ t: h[0], s: 0.85, dur: h[1] - h[0] });
    for (const [t, s] of hits) if (!held.some((h) => t >= h[0] - 150 && t <= h[1])) out.push({ t, s: clamp(s), dur: 0 });
    out.sort((x, y) => x.t - y.t);
    return out;
  }
  for (const [t, s] of hits) {
    if (t <= t0 || t > t1) continue;
    let dur = 0;
    if (sustainCh) {
      dur = sustainMs(sustainCh, a.fps, t, 900, 0.62);
      if (dur < 160) dur = 0;
    }
    out.push({ t, s: clamp(s), dur });
  }
  return out;
}

// ---------- pitch ----------

/** Runs of consecutive indices where voiced[i] >= threshold, each with at least minLen points. */
export function voicedRuns(voiced: ArrayLike<number>, threshold = 0.5, minLen = 2): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= voiced.length; i++) {
    const on = i < voiced.length && (voiced[i] as number) >= threshold;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      if (i - start >= minLen) runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Weighted 5-tap smoothing in place (edges clamp). */
export function smooth5(a: Float32Array): Float32Array {
  const n = a.length;
  const src = Float32Array.from(a);
  const w = [1, 4, 6, 4, 1];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += (w[k + 2] as number) * (src[Math.max(0, Math.min(n - 1, i + k))] as number);
    a[i] = s / 16;
  }
  return a;
}

// ---------- geometry ----------

/** Corner points of a regular polygon (screen coordinates, y down). */
export function polygonPoints(sides: number, radius: number, rotation: number, cx = 0, cy = 0): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * TAU - Math.PI / 2;
    pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return pts;
}

/** Smooth periodic wobble in [-1, 1]: a sum of three sines of the angle with moving phases. */
export function wobble(theta: number, lobes: number, p1: number, p2: number, p3: number): number {
  return 0.55 * Math.sin(lobes * theta + p1) + 0.1 * Math.sin((2 * Math.round(lobes) + 1) * theta - p2) + 0.25 * Math.sin(3 * theta + p3);
}

/** Frame-level basics every shape layer computes the same way. */
export interface Basics {
  short: number;
  cx: number;
  cy: number;
  scale: number;
  rot: number;
  glowPx: number;
  bright: number;
  a: number;
}
export function basics(f: { w: number; h: number; params: Record<string, number | string | boolean>; opacity: number }): Basics {
  const short = Math.min(f.w, f.h);
  const p = f.params;
  return {
    short,
    cx: (p.x as number) * f.w,
    cy: (1 - (p.y as number)) * f.h,
    scale: p.scale as number,
    rot: ((p.rotation as number) * Math.PI) / 180,
    glowPx: (p.glow as number) * short * 0.012,
    bright: p.brightness as number,
    a: f.opacity,
  };
}
