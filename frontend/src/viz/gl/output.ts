/**
 * The global post chain's fixed end (SPEC.md §6.5 step 5–6): a dual-filter
 * bloom, vignette and grain, ACES-fit tonemapping, sRGB and a dither, written
 * to the canvas. Overlay mode writes colour over an alpha matte (2× tall).
 */
import { FULLSCREEN_VS, Fullscreen, Program, Target } from "./core";

const PREFILTER = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_threshold; uniform float u_knee;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-4);
  float contrib = max(soft, br - u_threshold) / max(br, 1e-4);
  o = vec4(c * contrib, 1.0);
}`;

const DOWN = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_src, uv).rgb * 4.0;
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;

const UP = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_texel;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_src, uv + u_texel * vec2(-2.0, 0.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(2.0, 0.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(0.0, -2.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(0.0, 2.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb * 2.0;
  o = vec4(c / 12.0, 1.0);
}`;

const FINAL = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_scene; uniform sampler2D u_bloom;
uniform float u_bloomAmt; uniform float u_vignette; uniform float u_grain; uniform float u_time;
uniform float u_exposure; uniform int u_overlay; uniform vec2 u_size;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 st = uv;
  bool alphaHalf = false;
  if (u_overlay == 1) { // canvas is W × 2H: top half colour, bottom half alpha (GL origin is bottom-left)
    alphaHalf = uv.y < 0.5;
    st = vec2(uv.x, alphaHalf ? uv.y * 2.0 : uv.y * 2.0 - 1.0);
  }
  vec4 s = texture(u_scene, st);
  vec3 hdr = (s.rgb + texture(u_bloom, st).rgb * u_bloomAmt) * u_exposure;
  vec2 q = st - 0.5;
  hdr *= mix(1.0, smoothstep(0.85, 0.2, length(q * vec2(u_size.x / u_size.y, 1.0)) * 0.9), u_vignette);
  vec3 c = aces(hdr);
  float n = ign(gl_FragCoord.xy + fract(u_time * 7.13) * 97.0);
  c += (n - 0.5) * u_grain * 0.08;
  c = toSrgb(clamp(c, 0.0, 1.0));
  c += (n - 0.5) / 255.0; // dither to 8-bit: no banding after H.264
  if (u_overlay == 1) {
    float a = clamp(max(max(c.r, max(c.g, c.b)) * 1.15, s.a), 0.0, 1.0);
    o = alphaHalf ? vec4(vec3(a), 1.0) : vec4(a > 0.002 ? clamp(c / a, 0.0, 1.0) : vec3(0.0), 1.0);
  } else {
    o = vec4(c, 1.0);
  }
}`;

export interface OutputParams {
  bloom: number; // 0..2
  threshold: number; // 0.4..2
  vignette: number; // 0..1
  grain: number; // 0..1
  exposure: number; // 0.5..2
  timeSec: number;
}

export class Output {
  private readonly pre: Program;
  private readonly down: Program;
  private readonly up: Program;
  private readonly fin: Program;
  private levels: Target[] = [];

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly fs: Fullscreen,
    w: number,
    h: number,
    private readonly levelCount = 6,
  ) {
    this.pre = new Program(gl, FULLSCREEN_VS, PREFILTER);
    this.down = new Program(gl, FULLSCREEN_VS, DOWN);
    this.up = new Program(gl, FULLSCREEN_VS, UP);
    this.fin = new Program(gl, FULLSCREEN_VS, FINAL);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    let lw = Math.max(1, w >> 1);
    let lh = Math.max(1, h >> 1);
    for (let i = 0; i < this.levelCount; i++) {
      this.levels.push(new Target(this.gl, lw, lh));
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
  }

  /** Runs bloom on scene and writes the final image to the default framebuffer (outW × outH). */
  present(scene: Target, outW: number, outH: number, overlay: boolean, p: OutputParams, draftBloom = false): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const levels = draftBloom ? this.levels.slice(1) : this.levels;
    const first = levels[0] as Target;
    first.bind();
    this.pre.use().tex("u_src", 0, scene.tex).f2("u_texel", 1 / scene.w, 1 / scene.h).f1("u_threshold", p.threshold).f1("u_knee", 0.5);
    this.fs.draw();
    for (let i = 1; i < levels.length; i++) {
      const src = levels[i - 1] as Target;
      const dst = levels[i] as Target;
      dst.bind();
      this.down.use().tex("u_src", 0, src.tex).f2("u_texel", 1 / src.w, 1 / src.h);
      this.fs.draw();
    }
    // Upsample, adding each wider level at 60%: wide glow fades, the core stays tight.
    gl.enable(gl.BLEND);
    gl.blendColor(0.6, 0.6, 0.6, 1);
    gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE);
    for (let i = levels.length - 1; i > 0; i--) {
      const src = levels[i] as Target;
      const dst = levels[i - 1] as Target;
      dst.bind();
      this.up.use().tex("u_src", 0, src.tex).f2("u_texel", 1 / src.w, 1 / src.h);
      this.fs.draw();
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    this.fin
      .use()
      .tex("u_scene", 0, scene.tex)
      .tex("u_bloom", 1, first.tex)
      .f1("u_bloomAmt", p.bloom * 0.4)
      .f1("u_vignette", p.vignette)
      .f1("u_grain", p.grain)
      .f1("u_time", p.timeSec)
      .f1("u_exposure", p.exposure)
      .i1("u_overlay", overlay ? 1 : 0)
      .f2("u_size", scene.w, scene.h);
    this.fs.draw();
  }

  dispose(): void {
    for (const t of this.levels) t.dispose();
    this.pre.dispose();
    this.down.dispose();
    this.up.dispose();
    this.fin.dispose();
  }
}
