/**
 * Scene transitions (SPEC.md §6.5 step 3): crossfade, cut, flash (white decays
 * over the length), zoom (outgoing scales up while the new scene fades in),
 * sweep (a golden-hour light band moving left to right) and glitch (RGB-split
 * blocks). Each effect compiles its shader on first use. All are pure
 * functions of (a, b, mix, tMs), so exports are reproducible.
 */
import { FULLSCREEN_VS, Fullscreen, Program, Target } from "./gl/core";
import { GLSL_COMMON } from "./gl/glsl";
import { flashLevel, glitchBell, glitchStep, sweepCentre } from "./post/px1math";
import type { TransitionKind } from "./types";
import {
  blurRadius,
  flashBlackGainA,
  flashBlackGainB,
  IRIS_SOFT,
  LUMA_EDGE,
  rgbSplitOffset,
  shakeOffset,
  slideOffset,
  spinAngle,
  spinBlur,
  STRIPE_COUNT,
  STRIPE_SOFT,
  swap,
  warpAmount,
  WARP_ANGLE,
  whipBlur,
  whipShift,
  zoomOutBlur,
  zoomOutScaleA,
  zoomOutScaleB,
  zoomOutWeight,
} from "./transitionsMath";

const HEAD = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_a; uniform sampler2D u_b; uniform float u_mix;
${GLSL_COMMON}
float ease(float x) { return x * x * (3.0 - 2.0 * x); }
`;

const CROSSFADE = `
void main() { o = mix(texture(u_a, uv), texture(u_b, uv), ease(u_mix)); }`;

const FLASH = `
uniform float u_flash;
void main() {
  vec4 c = mix(texture(u_a, uv), texture(u_b, uv), smoothstep(0.0, 0.22, u_mix));
  c.rgb += u_flash * vec3(1.0, 0.97, 0.92);
  c.a = max(c.a, min(u_flash, 1.0));
  o = c;
}`;

const ZOOM = `
void main() {
  float e = ease(u_mix);
  vec4 a = texture(u_a, (uv - 0.5) / (1.0 + 0.5 * e) + 0.5);
  vec4 b = texture(u_b, (uv - 0.5) / (1.0 + 0.08 * (1.0 - e)) + 0.5);
  o = mix(a, b, smoothstep(0.1, 0.9, u_mix));
}`;

const SWEEP = `
uniform float u_centre; uniform float u_half;
void main() {
  float d = (uv.x + 0.14 * (uv.y - 0.5)) - u_centre;
  float w = smoothstep(u_half * 0.3, -u_half * 0.3, d);
  vec4 c = mix(texture(u_a, uv), texture(u_b, uv), w);
  float k = d / (u_half * 0.55);
  float band = exp(-k * k) * (0.5 + 0.5 * smoothstep(u_half * 2.0, 0.0, abs(d)));
  c.rgb += band * 0.9 * vec3(1.0, 0.78, 0.45);
  c.a = max(c.a, min(band, 1.0));
  o = c;
}`;

const GLITCH = `
uniform float u_bell; uniform float u_step;
void main() {
  float row = floor(uv.y * 36.0);
  float col = floor(uv.x * 12.0);
  float hr = hash21(vec2(row, u_step * 1.7));
  float hb = hash21(vec2(row * 0.37 + col, u_step * 0.9 + 11.0));
  float live = step(0.35, hr) * u_bell;
  float dx = (hash21(vec2(row, u_step + 5.0)) - 0.5) * 0.16 * live;
  float split = (0.004 + 0.02 * hb) * live;
  float m = u_mix + (hb - 0.5) * 0.7 * u_bell;
  vec2 q = vec2(uv.x + dx, uv.y);
  float useB = step(0.5, m);
  vec4 s0 = mix(texture(u_a, q), texture(u_b, q), useB);
  float r = mix(texture(u_a, q + vec2(split, 0.0)).r, texture(u_b, q + vec2(split, 0.0)).r, useB);
  float b = mix(texture(u_a, q - vec2(split, 0.0)).b, texture(u_b, q - vec2(split, 0.0)).b, useB);
  o = vec4(r, s0.g, b, s0.a);
}`;

/** Helpers for the Edit Studio FX transitions: mirrored edges, smooth clamp, aspect. */
const FX_HEAD = `
float mir1(float x) { return (x >= 0.0 && x <= 1.0) ? x : 1.0 - abs(1.0 - mod(x, 2.0)); }
vec2 mir(vec2 p) { return vec2(mir1(p.x), mir1(p.y)); }
float sm(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float revealEdge(float d, float r, float soft) { return 1.0 - sm((d - (r - soft)) / soft); }
float aspect() { vec2 s = vec2(textureSize(u_a, 0)); return s.x / s.y; }
vec2 rot(vec2 p, float ang) { float c = cos(ang), s = sin(ang); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec4 pickTex(float useB, vec2 p) { return useB > 0.5 ? texture(u_b, mir(p)) : texture(u_a, mir(p)); }
`;

const ZOOMOUT = `
uniform float u_sa; uniform float u_sb; uniform float u_w; uniform float u_blur;
vec4 radial(sampler2D t, float s) {
  vec2 c = vec2(0.5);
  if (u_blur <= 0.0) return texture(t, mir(c + (uv - c) * s));
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float f = float(i) / 7.0 - 0.5;
    acc += texture(t, mir(c + (uv - c) * s * (1.0 + u_blur * f)));
  }
  return acc / 8.0;
}
void main() { o = mix(radial(u_a, u_sa), radial(u_b, 1.0 / u_sb), u_w); }`;

const SPIN = `
uniform float u_use; uniform float u_ang; uniform float u_blur;
void main() {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  if (u_blur <= 0.0 && u_ang == 0.0) { o = pickTex(u_use, uv); return; }
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0 - 0.5;
    vec2 q = rot(p, u_ang + u_blur * f) / vec2(asp, 1.0) + 0.5;
    acc += pickTex(u_use, q);
  }
  o = acc / 12.0;
}`;

const WHIP = `
uniform float u_use; uniform float u_shift; uniform float u_blur;
void main() {
  if (u_blur <= 0.0 && u_shift == 0.0) { o = pickTex(u_use, uv); return; }
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0 - 0.5;
    acc += pickTex(u_use, vec2(uv.x + u_shift + u_blur * f, uv.y));
  }
  o = acc / 16.0;
}`;

const SLIDE = `
uniform float u_off;
void main() {
  float t = uv.x + u_off;
  o = t < 1.0 ? texture(u_a, vec2(t, uv.y)) : texture(u_b, vec2(t - 1.0, uv.y));
}`;

const BLUR = `
uniform float u_use; uniform float u_radius;
void main() {
  if (u_radius <= 0.0) { o = pickTex(u_use, uv); return; }
  float asp = aspect();
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.399963;
    float r = u_radius * sqrt((float(i) + 0.5) / 16.0);
    acc += pickTex(u_use, uv + vec2(cos(a) / asp, sin(a)) * r);
  }
  o = acc / 16.0;
}`;

const RGBSPLIT = `
uniform float u_use; uniform float u_off;
void main() {
  vec2 d = vec2(u_off, 0.0);
  vec4 c = pickTex(u_use, uv);
  float r = pickTex(u_use, uv + d).r;
  float b = pickTex(u_use, uv - d).b;
  o = vec4(r, c.g, b, c.a);
}`;

const SHAKE = `
uniform float u_use; uniform vec2 u_off;
void main() {
  if (u_off.x == 0.0 && u_off.y == 0.0) { o = pickTex(u_use, uv); return; }
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    float f = 0.5 + 0.5 * float(i) / 5.0;
    acc += pickTex(u_use, uv + u_off * f);
  }
  o = acc / 6.0;
}`;

const WARP = `
uniform float u_use; uniform float u_amt;
void main() {
  if (u_amt <= 0.0) { o = pickTex(u_use, uv); return; }
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float R = 0.5 * length(vec2(asp, 1.0));
  float fall = 1.0 - clamp(length(p) / R, 0.0, 1.0);
  vec2 q = rot(p, ${WARP_ANGLE.toFixed(4)} * u_amt * fall * fall) / vec2(asp, 1.0) + 0.5;
  o = pickTex(u_use, q);
}`;

const LUMA = `
void main() {
  vec4 a = texture(u_a, uv);
  vec4 b = texture(u_b, uv);
  float l = clamp(dot(a.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float e = ${LUMA_EDGE.toFixed(4)};
  float t = u_mix * (1.0 + 2.0 * e) - e;
  o = mix(a, b, sm((t - (l - e)) / (2.0 * e)));
}`;

const IRIS = `
void main() {
  float asp = aspect();
  float d = length((uv - 0.5) * vec2(asp, 1.0));
  float soft = ${IRIS_SOFT.toFixed(4)};
  float r = u_mix * (0.5 * length(vec2(asp, 1.0)) + soft);
  o = mix(texture(u_a, uv), texture(u_b, uv), revealEdge(d, r, soft));
}`;

const STRIPES = `
void main() {
  float s = (uv.x * aspect() + uv.y) * ${STRIPE_COUNT.toFixed(1)};
  float i = floor(s);
  float f = s - i;
  if (mod(i, 2.0) > 0.5) f = 1.0 - f;
  float soft = ${STRIPE_SOFT.toFixed(4)};
  o = mix(texture(u_a, uv), texture(u_b, uv), revealEdge(f, u_mix * (1.0 + soft), soft));
}`;

const FLASHBLACK = `
uniform float u_ga; uniform float u_gb;
void main() {
  vec4 c = u_gb > 0.0 ? texture(u_b, uv) : texture(u_a, uv);
  float g = u_gb > 0.0 ? u_gb : u_ga;
  o = vec4(c.rgb * g, c.a * g + (1.0 - g));
}`;

const SOURCES: Partial<Record<TransitionKind, string>> = {
  crossfade: CROSSFADE,
  flash: FLASH,
  zoom: ZOOM,
  sweep: SWEEP,
  glitch: GLITCH,
  zoomout: ZOOMOUT,
  spin: SPIN,
  whip: WHIP,
  slide: SLIDE,
  blur: BLUR,
  rgbsplit: RGBSPLIT,
  shake: SHAKE,
  warp: WARP,
  luma: LUMA,
  iris: IRIS,
  stripes: STRIPES,
  flashblack: FLASHBLACK,
};

/** The Edit Studio FX kinds: their shaders use FX_HEAD. */
const FX_KINDS: ReadonlySet<string> = new Set([
  "zoomout", "spin", "whip", "slide", "blur", "rgbsplit", "shake", "warp", "luma", "iris", "stripes", "flashblack",
]);

/** The fragment source of a kind (undefined for cut, which uses the crossfade). */
export function transitionSource(kind: TransitionKind): string | undefined {
  return SOURCES[kind];
}

/** Half width of the sweep light band, in uv units. */
const SWEEP_HALF = 0.2;

export class Transitions {
  private readonly programs = new Map<string, Program>();
  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly fs: Fullscreen,
  ) {}

  private program(kind: string): Program {
    let p = this.programs.get(kind);
    if (!p) {
      p = new Program(this.gl, FULLSCREEN_VS, HEAD + (FX_KINDS.has(kind) ? FX_HEAD : "") + (SOURCES[kind as TransitionKind] ?? CROSSFADE));
      this.programs.set(kind, p);
    }
    return p;
  }

  /** Composites outgoing a and incoming b at progress mix (0..1) into out. */
  render(kind: TransitionKind, a: Target, b: Target, mix: number, out: Target, tMs: number): void {
    const m = Math.max(0, Math.min(1, mix));
    const key = kind === "cut" ? "crossfade" : kind;
    out.bind();
    this.gl.disable(this.gl.BLEND);
    const p = this.program(key).use().tex("u_a", 0, a.tex).tex("u_b", 1, b.tex).f1("u_mix", m);
    switch (key) {
      case "flash":
        p.f1("u_flash", flashLevel(m));
        break;
      case "sweep":
        p.f1("u_centre", sweepCentre(m, SWEEP_HALF)).f1("u_half", SWEEP_HALF);
        break;
      case "glitch":
        p.f1("u_bell", glitchBell(m)).f1("u_step", glitchStep(tMs));
        break;
      case "zoomout":
        p.f1("u_sa", zoomOutScaleA(m)).f1("u_sb", zoomOutScaleB(m)).f1("u_w", zoomOutWeight(m)).f1("u_blur", zoomOutBlur(m));
        break;
      case "spin":
        p.f1("u_use", swap(m)).f1("u_ang", spinAngle(m)).f1("u_blur", spinBlur(m));
        break;
      case "whip":
        p.f1("u_use", swap(m)).f1("u_shift", whipShift(m)).f1("u_blur", whipBlur(m));
        break;
      case "slide":
        p.f1("u_off", slideOffset(m));
        break;
      case "blur":
        p.f1("u_use", swap(m)).f1("u_radius", blurRadius(m));
        break;
      case "rgbsplit":
        p.f1("u_use", swap(m)).f1("u_off", rgbSplitOffset(m));
        break;
      case "shake": {
        const [x, y] = shakeOffset(tMs, m);
        p.f1("u_use", swap(m)).f2("u_off", x, y);
        break;
      }
      case "warp":
        p.f1("u_use", swap(m)).f1("u_amt", warpAmount(m));
        break;
      case "flashblack":
        // a fades to black by 0.5, then b fades in; u_gb > 0 selects b.
        p.f1("u_ga", flashBlackGainA(m)).f1("u_gb", m > 0.5 ? flashBlackGainB(m) : 0);
        break;
      default:
        break;
    }
    this.fs.draw();
  }

  dispose(): void {
    for (const p of this.programs.values()) p.dispose();
    this.programs.clear();
  }
}
