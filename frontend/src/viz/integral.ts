/**
 * Integrals of rates (SPEC.md §C2.1). Anything that moves at a speed (travel,
 * spin, drift) is the integral of that speed over time, never `speed × time`:
 * a modulated speed then changes how fast the picture moves, it never moves the
 * picture to a different place.
 *
 * An expression is a product of factors joined with `*`: a number literal,
 * `intensity`, a numeric parameter of the layer (its effective, modulated value
 * at that moment) or a signal id (its raw series value). `"speed*0.08"` is the
 * spin angle for a modulated `speed`; `"spin*bass.level"` is audio-driven spin.
 *
 * The integral is a left Riemann sum at 1/120 s steps, kept as a prefix array
 * per (layer instance, expression), extended lazily and kept across backward
 * seeks. Because the steps sit on a fixed grid, the value at a time never
 * depends on which times were asked for before: preview and export agree.
 */
import type { Analysis } from "./analysis";
import { SIGNAL_META, type Signals } from "./signals";
import type { SignalId } from "./types";

export const INTEGRAL_STEP_MS = 1000 / 120;

/** What a rate expression is evaluated against. */
export interface RateEnv {
  analysis: Analysis;
  signals: Signals;
  /** Effective numeric value of a parameter at a time; undefined when the name isn't a numeric parameter. */
  param(name: string, tMs: number): number | undefined;
  intensity: number;
  /** The show's speed: the integral is over motion time. */
  speed: number;
}

type Factor = { k: "const"; v: number } | { k: "intensity" } | { k: "name"; name: string };

const parsed = new Map<string, Factor[]>();

function parse(expr: string): Factor[] {
  let f = parsed.get(expr);
  if (f) return f;
  f = expr
    .split("*")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s): Factor => {
      const n = Number(s);
      if (Number.isFinite(n)) return { k: "const", v: n };
      if (s === "intensity") return { k: "intensity" };
      return { k: "name", name: s };
    });
  parsed.set(expr, f);
  return f;
}

/** Local beats per second at a time (the reciprocal of the current beat interval). */
export function beatRate(a: Analysis, tMs: number): number {
  const beats = a.audio.beats;
  const i = a.beatAt(tMs).index;
  if (i < 0 || beats.length < 2) return 2;
  const cur = beats[i] as number;
  const next = beats[i + 1] ?? cur + (cur - (beats[i - 1] ?? cur - 500));
  return 1000 / Math.max(1, next - cur);
}

/** Beats elapsed at a time (continuous; index + phase). */
export function beatCount(a: Analysis, tMs: number): number {
  const b = a.beatAt(tMs);
  return b.index < 0 ? tMs / 500 : b.index + b.phase;
}

/** The rate of an expression at a time (per second; times beats per second when `perBeat`). */
export function rateAt(expr: string, env: RateEnv, tMs: number, perBeat: boolean): number {
  let r = 1;
  for (const f of parse(expr)) {
    if (f.k === "const") r *= f.v;
    else if (f.k === "intensity") r *= env.intensity;
    else {
      const p = env.param(f.name, tMs);
      if (p !== undefined) r *= p;
      else if (SIGNAL_META.has(f.name as SignalId)) r *= env.signals.value(f.name as SignalId, tMs);
      else return 0;
    }
  }
  return perBeat ? r * beatRate(env.analysis, tMs) : r;
}

interface Entry {
  sig: string;
  sums: Float64Array; // sums[k] = integral from 0 to k steps
  n: number; // number of valid entries (sums[0..n-1])
}

/** Prefix caches of integrals, per layer instance. One per engine; reset it when the analysis changes. */
export class Integrator {
  private readonly entries = new Map<string, Map<string, Entry>>();

  clear(): void {
    this.entries.clear();
  }

  /**
   * ∫₀ᵗ rate over motion time. `sig` identifies everything the rate depends on
   * besides the time (the layer's params, the show's mix/intensity/speed); when
   * it changes the cache for that expression restarts.
   */
  value(instKey: string, expr: string, perBeat: boolean, sig: string, env: RateEnv, tMs: number): number {
    if (!(tMs > 0)) return 0;
    let m = this.entries.get(instKey);
    if (!m) {
      m = new Map();
      this.entries.set(instKey, m);
    }
    const ck = (perBeat ? "b:" : "t:") + expr;
    let e = m.get(ck);
    if (!e || e.sig !== sig) {
      e = { sig, sums: new Float64Array(1024), n: 1 };
      m.set(ck, e);
    }
    const k = Math.floor(tMs / INTEGRAL_STEP_MS);
    if (k >= e.n) {
      if (k + 1 > e.sums.length) {
        const bigger = new Float64Array(Math.max(k + 1, e.sums.length * 2));
        bigger.set(e.sums.subarray(0, e.n));
        e.sums = bigger;
      }
      const dt = INTEGRAL_STEP_MS / 1000;
      for (let i = e.n; i <= k; i++) e.sums[i] = (e.sums[i - 1] as number) + rateAt(expr, env, (i - 1) * INTEGRAL_STEP_MS, perBeat) * dt;
      e.n = k + 1;
    }
    const rest = (tMs - k * INTEGRAL_STEP_MS) / 1000;
    return ((e.sums[k] as number) + rateAt(expr, env, k * INTEGRAL_STEP_MS, perBeat) * rest) * env.speed;
  }
}
