/**
 * Shared helpers for the background layers (SPEC.md §6.7 #2-#10): a fullscreen
 * shader wrapper, gradient-noise GLSL, and the built-in "drive" that makes a
 * layer react to the music with no modulation bound (every param also stays
 * bindable). Everything here is a pure function of the frame input.
 */
import { FULLSCREEN_VS, Program } from "../../gl/core";
import { GLSL_COMMON, GLSL_PALETTE } from "../../gl/glsl";
import type { Signals } from "../../signals";
import type { SignalId } from "../../types";
import { setPaletteUniforms, type FrameInput, type LayerContext, type LayerInstance, type ParamSpec } from "../registry";

/** Gradient noise, rotated fBm, smooth palette lookup and small helpers. */
export const GLSL_BG = `
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec2 ghash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453123); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(ghash(i), f), dot(ghash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(ghash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(ghash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y) * 0.5 + 0.5;
}
const mat2 FBM_ROT = mat2(0.8, -0.6, 0.6, 0.8);
float gfbm(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 7; i++) { if (i >= oct) break; v += a * gnoise(p); p = FBM_ROT * p * 2.02 + 11.7; a *= 0.5; }
  return v / (1.0 - pow(0.5, float(oct)));
}
vec3 palAt(float x, float shift) { return paletteColor(x + shift); }
float softPulse(float x, float w) { return exp(-x * x / (w * w)); }
`;

/** Declarations every background shader shares (prepended after the header). */
export const BG_UNIFORMS = `
uniform float u_t; uniform float u_opacity; uniform float u_aspect; uniform vec2 u_res;
`;

export function bgShader(body: string): string {
  return `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
${GLSL_PALETTE}
${GLSL_BG}
${BG_UNIFORMS}
${body}`;
}

/**
 * A layer drawn by one fullscreen shader. `setUniforms` runs each frame after
 * the common uniforms (u_t is motionSec, u_opacity, u_aspect, u_res, palette).
 */
export function fullscreenLayer(ctx: LayerContext, fs: string, setUniforms: (p: Program, f: FrameInput) => void | false, extraDispose?: () => void): LayerInstance {
  const prog = new Program(ctx.gl, FULLSCREEN_VS, fs);
  return {
    render(f) {
      prog.use().f1("u_t", f.motionSec).f1("u_opacity", f.opacity).f1("u_aspect", f.w / f.h).f2("u_res", f.w, f.h);
      setPaletteUniforms(prog, f.palette);
      if (setUniforms(prog, f) === false) return;
      ctx.fullscreen.draw();
    },
    dispose() {
      prog.dispose();
      extraDispose?.();
    },
  };
}

/** The params every background shares; spread into a layer's param table. */
export function commonParams(o: { brightness: number; react?: number; speed?: number }): Record<string, ParamSpec> {
  return {
    brightness: { kind: "number", label: "Brightness", min: 0, max: 2, default: o.brightness },
    react: { kind: "number", label: "Music reaction", min: 0, max: 2, default: o.react ?? 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, default: o.speed ?? 1 },
    colorShift: { kind: "number", label: "Colour shift", min: 0, max: 4, default: 0 },
  };
}

const ease = (x: number) => x * x * (3 - 2 * x);
const sat = (x: number) => Math.max(0, Math.min(1, x));

/** Built-in reactions of a background (all 0..~1, already scaled by the layer's `react`). */
export interface Drive {
  level: number;
  bass: number;
  mid: number;
  hi: number;
  kick: number;
  snare: number;
  hats: number;
  beat: number;
  bar: number;
  drop: number;
  lift: number;
  drums: number;
  vocals: number;
  energy: number;
  /** -1 (left) .. 1 (right). */
  balance: number;
}

export function drive(f: FrameInput, react: number): Drive {
  const s = f.signals;
  const t = f.tMs;
  const contrast = (x: number) => sat((x - 0.12) / 0.8);
  return {
    level: contrast(s.value("mix.level", t, 30, 260)) * react,
    bass: contrast(s.value("bass.level", t, 25, 300)) * react,
    mid: contrast(s.value("mix.mid", t, 30, 300)) * react,
    hi: contrast(s.value("mix.brilliance", t, 15, 160)) * react,
    kick: s.value("kick", t, 4, 120) * react,
    snare: s.value("snare", t, 4, 140) * react,
    hats: s.value("hats", t, 4, 90) * react,
    beat: s.value("beat.pulse", t, 4, 140) * react,
    bar: s.value("bar.pulse", t, 4, 300) * react,
    drop: s.value("drop.pulse", t, 20, 500) * react,
    lift: s.value("lift.pulse", t, 50, 400) * react,
    drums: contrast(s.value("drums.level", t, 25, 260)) * react,
    vocals: contrast(s.value("vocals.level", t, 60, 350)) * react,
    energy: s.value("section.energy", t, 300, 700),
    balance: (s.value("mix.balance", t, 80, 250) - 0.5) * 2,
  };
}

const cumCache = new WeakMap<Signals, Map<string, Float64Array>>();

/** The integral of a signal's raw series from 0 to tMs (value·seconds); any frame in O(1). */
export function cumSignal(s: Signals, id: SignalId, tMs: number): number {
  let m = cumCache.get(s);
  if (!m) {
    m = new Map();
    cumCache.set(s, m);
  }
  let c = m.get(id);
  if (!c) {
    const src = s.get(id);
    c = new Float64Array(src.length + 1);
    for (let i = 0; i < src.length; i++) c[i + 1] = (c[i] ?? 0) + (src[i] ?? 0) / s.fps;
    m.set(id, c);
  }
  const fr = Math.max(0, Math.min(c.length - 1, (tMs / 1000) * s.fps));
  const i = Math.floor(fr);
  const a = c[i] ?? 0;
  const b = c[Math.min(c.length - 1, i + 1)] ?? a;
  return a + (b - a) * (fr - i);
}

/** Position in beats, monotonic and continuous; each beat surges (`punch` 0 = linear, 1 = strong ease). */
export function beatPosition(f: FrameInput, punch: number): number {
  const b = f.analysis.beatAt(f.tMs);
  if (b.index < 0) return f.tMs / 500;
  return b.index + b.phase * (1 - punch) + ease(b.phase) * punch;
}

/** Position in bars, continuous. */
export function barPosition(f: FrameInput): number {
  const b = f.analysis.barAt(f.tMs);
  if (b.index < 0) return f.tMs / 2000;
  return b.index + b.phase;
}

/** Seconds of speed-scaled time per real second (show speed), for cumulative terms. */
export function speedScale(f: FrameInput): number {
  return f.tMs > 0 ? f.motionSec / (f.tMs / 1000) : 1;
}

/** Smoothstep on the CPU. */
export const smooth = ease;
export const clamp01 = sat;
