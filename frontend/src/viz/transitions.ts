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

const SOURCES: Partial<Record<TransitionKind, string>> = {
  crossfade: CROSSFADE,
  flash: FLASH,
  zoom: ZOOM,
  sweep: SWEEP,
  glitch: GLITCH,
};

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
      p = new Program(this.gl, FULLSCREEN_VS, HEAD + (SOURCES[kind as TransitionKind] ?? CROSSFADE));
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
