/**
 * Scene transitions (SPEC.md §6.5 step 3). Wave 0 has crossfade and cut; PX1
 * adds flash, zoom, sweep and glitch here (each falls back to crossfade until then).
 */
import { FULLSCREEN_VS, Fullscreen, Program, Target } from "./gl/core";
import type { TransitionKind } from "./types";

const CROSSFADE = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_a; uniform sampler2D u_b; uniform float u_mix;
void main() { float w = u_mix * u_mix * (3.0 - 2.0 * u_mix); o = mix(texture(u_a, uv), texture(u_b, uv), w); }`;

export class Transitions {
  private readonly crossfade: Program;
  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly fs: Fullscreen,
  ) {
    this.crossfade = new Program(gl, FULLSCREEN_VS, CROSSFADE);
  }

  /** Composites outgoing a and incoming b at progress mix (0..1) into out. */
  render(kind: TransitionKind, a: Target, b: Target, mix: number, out: Target, _tMs: number): void {
    void kind;
    out.bind();
    this.gl.disable(this.gl.BLEND);
    this.crossfade.use().tex("u_a", 0, a.tex).tex("u_b", 1, b.tex).f1("u_mix", Math.max(0, Math.min(1, mix)));
    this.fs.draw();
  }

  dispose(): void {
    this.crossfade.dispose();
  }
}
