/**
 * Moments (SPEC §24.3), pure logic: mapping a source's moments onto a clip's
 * timeline, and writing/removing the keyframes a "Use" produces. Every key
 * this feature writes is found again from its time alone (no side table), so
 * removing a pulse never touches the user's own keys.
 */
import type { EditClip, EditMoment } from "@/lib/api";
import { interpolateKeys } from "@/viz/edit/params";
import { MAX_EFFECTS, MAX_KEYS, SPEED_MAX, SPEED_MIN } from "@/viz/edit/schema";
import type { EditParam, EditPost, Key, Marker } from "@/viz/edit/types";
import "@/viz/post";
import { postDef } from "@/viz/post/registry";
import type { PostType } from "@/viz/types";
import { newEffect } from "../inspector/EffectsStack";
import { buildParam, KEY_TOL_MS, paramBase, paramKeys, valueAt, withKeys } from "../inspector/paramOps";

// ---- kinds and effects ----

export type MomentKind = "accent" | "cut" | "motion";

export const KIND_LABELS: Record<MomentKind, string> = { accent: "Song accent", cut: "Shot change", motion: "Motion burst" };

export type MomentEffect = "punch" | "flash" | "shake" | "zoomblur" | "rgb" | "glitch" | "shockwave" | "freeze";

export interface EffectChoice {
  id: MomentEffect;
  label: string;
  tip: string;
  /** The post type whose Amount is pulsed (none for Freeze). */
  post?: PostType;
  /** The enum param that must read "amount" so the keyframes drive it. */
  driver?: string;
  /** Decay time of the pulse (ms). */
  decayMs: number;
}

export const EFFECT_CHOICES: readonly EffectChoice[] = [
  { id: "punch", label: "Punch", tip: "A quick zoom punch on the moment", post: "punch", decayMs: 250 },
  { id: "flash", label: "Flash", tip: "A white flash on the moment", post: "flash", decayMs: 160 },
  { id: "shake", label: "Shake", tip: "A camera shake on the moment", post: "shake", driver: "trigger", decayMs: 300 },
  { id: "zoomblur", label: "Zoom blur", tip: "A radial zoom blur on the moment", post: "zoomblur", decayMs: 250 },
  { id: "rgb", label: "RGB split", tip: "A burst of colour fringing on the moment", post: "chromatic", driver: "source", decayMs: 250 },
  { id: "glitch", label: "Glitch", tip: "A digital glitch on the moment", post: "glitch", driver: "trigger", decayMs: 250 },
  { id: "shockwave", label: "Shockwave", tip: "A ripple that spreads from the centre on the moment", post: "shockwave", decayMs: 450 },
  { id: "freeze", label: "Freeze", tip: "Hold the picture still for one beat, then carry on at the previous speed", decayMs: 0 },
];

export function effectChoice(id: MomentEffect): EffectChoice {
  return EFFECT_CHOICES.find((e) => e.id === id) as EffectChoice;
}

/** What each kind of moment starts with. */
export const DEFAULT_EFFECT: Record<MomentKind, MomentEffect> = { accent: "punch", cut: "flash", motion: "shake" };

const EPS = 1e-3;

// ---- source ms -> clip ms ----

export interface ClipMoment {
  /** "<kind>:<clipMs>" */
  id: string;
  kind: MomentKind;
  /** Clip-relative ms (rounded). */
  clipMs: number;
  /** Timeline ms. */
  timelineMs: number;
  strength: number;
}

export function strengthWord(s: number): string {
  return s >= 0.66 ? "strong" : s >= 0.33 ? "medium" : "subtle";
}

/** m:ss.s */
export function formatMoment(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100));
  const m = Math.floor(t / 600);
  const s = (t - m * 600) / 10;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

export function momentTip(kind: MomentKind, ms: number, strength: number): string {
  return `${KIND_LABELS[kind]} at ${formatMoment(ms)} (${strengthWord(strength)})`;
}

/** The source positions of a clip's output frames: src[j] at clip time u[j] (the last entry is the clip's end). */
export interface SourceMap {
  u: Float64Array;
  src: Float64Array;
}

export function buildSourceMap(clip: Pick<EditClip, "startMs" | "endMs" | "inMs">, fps: number, speedOf: (uMs: number) => number): SourceMap {
  const len = Math.max(0, clip.endMs - clip.startMs);
  const step = 1000 / Math.max(1, fps);
  const n = Math.ceil(len / step) + 1;
  const u = new Float64Array(n);
  const src = new Float64Array(n);
  let p = clip.inMs;
  for (let j = 0; j < n; j++) {
    const at = Math.min(len, j * step);
    u[j] = at;
    src[j] = p;
    const s = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speedOf(at)));
    p += s * (Math.min(len, (j + 1) * step) - at);
  }
  return { u, src };
}

/** The clip time at which the clip shows source time `srcMs`, or null when it never does. First time wins (a freeze). */
export function sourceToClipMs(map: SourceMap, srcMs: number): number | null {
  const n = map.src.length;
  if (n === 0 || srcMs < (map.src[0] as number) - EPS) return null;
  if (srcMs > (map.src[n - 1] as number) + EPS) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((map.src[mid] as number) >= srcMs) hi = mid;
    else lo = mid + 1;
  }
  if (lo === 0) return map.u[0] as number;
  const s0 = map.src[lo - 1] as number;
  const s1 = map.src[lo] as number;
  const u0 = map.u[lo - 1] as number;
  const u1 = map.u[lo] as number;
  if (s1 <= s0) return u1;
  return u0 + ((u1 - u0) * (srcMs - s0)) / (s1 - s0);
}

/** The speed the clip has at clip time u (its keys only). */
export function speedOfClip(speed: EditParam): (u: number) => number {
  if (typeof speed === "number") return () => speed;
  const keys = speed.keys;
  return keys && keys.length ? (u) => interpolateKeys(keys, u) : () => speed.base;
}

/** Footage moments of a source placed on the clip (those inside the clip's played range), ascending. */
export function footageMoments(clip: EditClip, fps: number, speed: EditParam, moments: readonly EditMoment[]): ClipMoment[] {
  if (!moments.length) return [];
  const map = buildSourceMap(clip, fps, speedOfClip(speed));
  const out: ClipMoment[] = [];
  for (const m of moments) {
    const kind: MomentKind = m.kind === "cut" ? "cut" : "motion";
    const u = sourceToClipMs(map, m.ms);
    if (u === null) continue;
    const clipMs = Math.round(u);
    out.push({ id: `${kind}:${clipMs}`, kind, clipMs, timelineMs: clip.startMs + clipMs, strength: m.strength });
  }
  return out.sort((a, b) => a.clipMs - b.clipMs);
}

/** The song's accents inside the clip. */
export function accentMoments(clip: Pick<EditClip, "startMs" | "endMs">, markers: readonly Marker[]): ClipMoment[] {
  const out: ClipMoment[] = [];
  for (const m of markers) {
    if (m.lane !== "accent" || m.ms < clip.startMs || m.ms >= clip.endMs) continue;
    const clipMs = Math.round(m.ms - clip.startMs);
    out.push({ id: `accent:${clipMs}`, kind: "accent", clipMs, timelineMs: m.ms, strength: m.strength });
  }
  return out.sort((a, b) => a.clipMs - b.clipMs);
}

/** Every moment of the clip, by time, at most `limit` (the strongest are kept). */
export function clipMoments(footage: readonly ClipMoment[], accents: readonly ClipMoment[], limit = 120): ClipMoment[] {
  const all = [...footage, ...accents];
  const kept = all.length > limit ? all.slice().sort((a, b) => b.strength - a.strength).slice(0, limit) : all;
  return kept.sort((a, b) => a.clipMs - b.clipMs || a.kind.localeCompare(b.kind));
}

/** One beat in ms around a timeline time, from the beat markers (500 when there are none). */
export function beatLengthMs(markers: readonly Marker[], atMs: number): number {
  const beats = markers.filter((m) => m.lane === "beat").map((m) => m.ms);
  if (beats.length < 2) return 500;
  let i = 0;
  while (i < beats.length - 1 && (beats[i + 1] as number) <= atMs) i++;
  const a = i > 0 ? i - 1 : i;
  const gaps: number[] = [];
  for (let j = a; j < Math.min(beats.length - 1, a + 4); j++) gaps.push((beats[j + 1] as number) - (beats[j] as number));
  gaps.sort((x, y) => x - y);
  const med = gaps[Math.floor(gaps.length / 2)] ?? 500;
  return med > 50 ? med : 500;
}

// ---- keys ----

export interface PulseOpts {
  /** Clip ms of the moment. */
  t: number;
  frameMs: number;
  decayMs: number;
  /** The clip's length (ms). */
  lenMs: number;
}

function keyAt(keys: readonly Key[], t: number): number {
  let best = -1;
  let bestD = KEY_TOL_MS + 1;
  for (const [i, k] of keys.entries()) {
    const d = Math.abs(k.t - t);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function pulseTimes(o: PulseOpts): { pre: number | null; peak: number; post: number | null } {
  const peak = Math.max(0, Math.min(o.lenMs, Math.round(o.t)));
  const pre = peak > KEY_TOL_MS ? Math.max(0, Math.round(peak - o.frameMs)) : null;
  const postT = Math.min(o.lenMs, Math.round(peak + o.decayMs));
  return { pre, peak, post: postT > peak + KEY_TOL_MS ? postT : null };
}

function buildParamKeys(p: EditParam, keys: readonly Key[]): EditParam {
  return buildParam(paramBase(p), keys, typeof p === "number" ? [] : (p.mods ?? []));
}

/** Whether the param has a pulse peak (a key above its rest value) at clip time t. */
export function hasPulse(p: EditParam, t: number): boolean {
  const keys = paramKeys(p);
  const i = keyAt(keys, t);
  return i >= 0 && (keys[i] as Key).v > paramBase(p) + EPS;
}

/**
 * Writes an attack/decay pulse: rest one frame before, `peak` at t, rest after
 * the decay. Existing keys at the neighbour times are kept, never duplicated.
 * Returns null when the key limit would be exceeded.
 */
export function writePulse(p: EditParam, o: PulseOpts, peak: number): EditParam | null {
  const rest = paramBase(p);
  const times = pulseTimes(o);
  const keys = paramKeys(p).slice();
  const put = (t: number, v: number, ease: Key["ease"], overwrite: boolean): boolean => {
    const i = keyAt(keys, t);
    if (i >= 0) {
      if (overwrite) keys[i] = { t: (keys[i] as Key).t, v, ease };
      return true;
    }
    if (keys.length >= MAX_KEYS) return false;
    keys.push({ t, v, ease });
    return true;
  };
  if (!put(times.peak, Math.max(peak, rest), "ease", true)) return null;
  if (times.pre !== null && !put(times.pre, rest, "linear", false)) return null;
  if (times.post !== null && !put(times.post, rest, "ease", false)) return null;
  keys.sort((a, b) => a.t - b.t);
  return withKeys(p, keys);
}

/** Removes the pulse at t: its peak, and its neighbours when they rest and no other pulse shares them. */
export function removePulse(p: EditParam, o: PulseOpts): EditParam {
  const rest = paramBase(p);
  const keys = paramKeys(p).slice();
  const times = pulseTimes(o);
  const pi = keyAt(keys, times.peak);
  if (pi < 0 || (keys[pi] as Key).v <= rest + EPS) return p;
  keys.splice(pi, 1);
  const others = keys.filter((k) => k.v > rest + EPS);
  const drop = (t: number | null, shared: (k: Key) => boolean) => {
    if (t === null) return;
    const i = keyAt(keys, t);
    if (i < 0 || Math.abs((keys[i] as Key).v - rest) > EPS) return;
    if (others.some(shared)) return;
    keys.splice(i, 1);
  };
  drop(times.pre, (k) => times.pre !== null && Math.abs(k.t - (times.pre + o.frameMs)) <= KEY_TOL_MS);
  drop(times.post, (k) => times.post !== null && Math.abs(k.t - (times.post - o.decayMs)) <= KEY_TOL_MS);
  return buildParamKeys(p, keys);
}

// ---- freeze (speed keys) ----

export interface FreezeOpts {
  t: number;
  frameMs: number;
  /** One beat. */
  beatMs: number;
  lenMs: number;
}

/** Writes a hold at 0 for one beat from t, then the previous speed again. Null when there is no room or the key limit is hit. */
export function writeFreeze(speed: EditParam, o: FreezeOpts): EditParam | null {
  const t = Math.max(0, Math.round(o.t));
  const f = Math.max(1, Math.round(o.frameMs));
  if (o.lenMs - t < 2 * f) return null;
  const end = Math.min(o.lenMs, Math.round(t + o.beatMs));
  const before = valueAt(speed, SPEED_MIN, SPEED_MAX, t);
  const after = valueAt(speed, SPEED_MIN, SPEED_MAX, end);
  const keys = paramKeys(speed).slice();
  const put = (at: number, v: number, ease: Key["ease"]): boolean => {
    const i = keyAt(keys, at);
    if (i >= 0) {
      keys[i] = { t: (keys[i] as Key).t, v, ease };
      return true;
    }
    if (keys.length >= MAX_KEYS) return false;
    keys.push({ t: at, v, ease });
    return true;
  };
  if (!put(t, before, "hold") || !put(t + f, 0, "hold")) return null;
  if (end < o.lenMs && end > t + f + KEY_TOL_MS && !put(end, after, "linear")) return null;
  keys.sort((a, b) => a.t - b.t);
  return withKeys(speed, keys);
}

/** Whether a freeze starts at clip time t. */
export function hasFreeze(speed: EditParam, t: number, frameMs: number): boolean {
  const keys = paramKeys(speed);
  const f = Math.max(1, Math.round(frameMs));
  const a = keyAt(keys, Math.round(t));
  const b = keyAt(keys, Math.round(t) + f);
  return a >= 0 && b >= 0 && a !== b && (keys[a] as Key).ease === "hold" && (keys[b] as Key).ease === "hold" && (keys[b] as Key).v < EPS;
}

export function removeFreeze(speed: EditParam, t: number, frameMs: number): EditParam {
  if (!hasFreeze(speed, t, frameMs)) return speed;
  const keys = paramKeys(speed).slice();
  const f = Math.max(1, Math.round(frameMs));
  const a = keyAt(keys, Math.round(t));
  const b = keyAt(keys, Math.round(t) + f);
  const bKey = keys[b] as Key;
  // The key that resumes the speed is the first one after the hold, when it is not itself a hold.
  const next = keys.findIndex((k, i) => i > b && k.t > bKey.t);
  const drop = new Set<number>([a, b]);
  if (next >= 0 && (keys[next] as Key).v > EPS && (keys[next] as Key).ease !== "hold") drop.add(next);
  return buildParamKeys(
    speed,
    keys.filter((_, i) => !drop.has(i)),
  );
}

// ---- applying rows to a clip's effects and speed ----

export interface ClipFx {
  effects: EditPost[];
  speed: EditParam;
}

export interface UseCtx {
  fps: number;
  /** One beat (ms) at the moment. */
  beatMs: number;
  lenMs: number;
  /** 0..1, scales the pulse peaks. */
  strength: number;
}

const AMOUNT = "amount";

function amountOf(post: EditPost): EditParam {
  const v = post.params[AMOUNT];
  return typeof v === "number" || (typeof v === "object" && v !== null) ? v : 0;
}

function amountMax(type: PostType): number {
  const spec = postDef(type)?.params[AMOUNT];
  return spec && spec.kind === "number" ? spec.max : 1;
}

/** The peak a moment of strength s reaches on an amount resting at `rest`. */
export function peakFor(type: PostType, rest: number, momentStrength: number, globalStrength: number): number {
  const max = amountMax(type);
  const frac = Math.max(0, Math.min(1, globalStrength * (0.3 + 0.7 * momentStrength)));
  return Math.min(max, rest + (max - rest) * frac);
}

function pulseOpts(c: EffectChoice, t: number, ctx: UseCtx): PulseOpts {
  return { t, frameMs: 1000 / Math.max(1, ctx.fps), decayMs: c.decayMs, lenMs: ctx.lenMs };
}

/** Which effect (if any) already pulses at clip time t. */
export function usedEffect(fx: ClipFx, t: number, fps: number): MomentEffect | null {
  if (hasFreeze(fx.speed, t, 1000 / Math.max(1, fps))) return "freeze";
  for (const c of EFFECT_CHOICES) {
    if (!c.post) continue;
    const post = fx.effects.find((e) => e.type === c.post);
    if (post && hasPulse(amountOf(post), t)) return c.id;
  }
  return null;
}

/** Removes whatever Use wrote at clip time t (every effect, and a freeze). */
export function applyUnuse(fx: ClipFx, t: number, ctx: UseCtx): ClipFx {
  const frameMs = 1000 / Math.max(1, ctx.fps);
  const speed = hasFreeze(fx.speed, t, frameMs) ? removeFreeze(fx.speed, t, frameMs) : fx.speed;
  const effects = fx.effects.map((e) => {
    const c = EFFECT_CHOICES.find((x) => x.post === e.type);
    if (!c) return e;
    const amount = amountOf(e);
    if (!hasPulse(amount, t)) return e;
    return { ...e, params: { ...e.params, [AMOUNT]: removePulse(amount, pulseOpts(c, t, ctx)) } };
  });
  return { effects, speed };
}

/** Turns a moment on with an effect. Null when the effect or key limit stops it. */
export function applyUse(fx: ClipFx, t: number, strength: number, effect: MomentEffect, ctx: UseCtx): ClipFx | null {
  const choice = effectChoice(effect);
  const cleared = applyUnuse(fx, t, ctx);
  if (!choice.post) {
    const speed = writeFreeze(cleared.speed, { t, frameMs: 1000 / Math.max(1, ctx.fps), beatMs: ctx.beatMs, lenMs: ctx.lenMs });
    return speed ? { ...cleared, speed } : null;
  }
  const effects = cleared.effects.slice();
  let i = effects.findIndex((e) => e.type === choice.post);
  if (i < 0) {
    if (effects.length >= MAX_EFFECTS) return null;
    const fresh = newEffect(choice.post);
    fresh.params[AMOUNT] = 0;
    if (choice.driver) fresh.params[choice.driver] = AMOUNT;
    effects.push(fresh);
    i = effects.length - 1;
  }
  const post = effects[i] as EditPost;
  const amount = amountOf(post);
  const next = writePulse(amount, pulseOpts(choice, t, ctx), peakFor(choice.post, paramBase(amount), strength, ctx.strength));
  if (!next) return null;
  effects[i] = { ...post, params: { ...post.params, [AMOUNT]: next } };
  return { ...cleared, effects };
}
