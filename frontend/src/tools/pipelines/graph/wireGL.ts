import { createContext, Program } from "@/viz/gl/core";
import { GLSL_COMMON } from "@/viz/gl/glsl";
import type { Pt } from "../graphModel";
import type { RGB } from "./wireStyle";

// Glowing wires on a WebGL2 canvas under the nodes. Each wire is a bezier
// ribbon drawn as a signed distance in a quad around its bounding box: a bright
// core plus a soft halo, with a shimmer or a travelling pulse along its length.
// Reuses the visualizer's context, program and SDF helpers (viz/gl).

const VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_res;
uniform vec4 u_box;
out vec2 v_px;
void main() {
  vec2 px = mix(u_box.xy, u_box.zw, a_pos);
  v_px = px;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SEGMENTS = 28;

const FS = `#version 300 es
precision highp float;
in vec2 v_px;
out vec4 o;
uniform vec2 u_p0; uniform vec2 u_p1; uniform vec2 u_p2; uniform vec2 u_p3;
uniform vec3 u_col;
uniform float u_core;
uniform float u_glow;
uniform float u_halo;
uniform float u_bright;
uniform float u_shimmer;
uniform float u_flow;
uniform float u_time;
uniform float u_additive;
uniform float u_seed;
uniform float u_dash;
${GLSL_COMMON}
vec2 bez(float t) {
  float u = 1.0 - t;
  return u*u*u*u_p0 + 3.0*u*u*t*u_p1 + 3.0*u*t*t*u_p2 + t*t*t*u_p3;
}
void main() {
  float best = 1e9;
  float bt = 0.0;
  vec2 prev = bez(0.0);
  for (int i = 1; i <= ${SEGMENTS}; i++) {
    vec2 cur = bez(float(i) / ${SEGMENTS}.0);
    vec2 pa = v_px - prev, ba = cur - prev;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    float d = length(pa - ba * h);
    if (d < best) { best = d; bt = (float(i - 1) + h) / ${SEGMENTS}.0; }
    prev = cur;
  }
  float edge = best - u_core * 0.5;
  // dashed wires (a value that may not fit): the core and halo break up along the curve
  float dm = mix(1.0, step(0.5, fract(bt * 24.0)), u_dash);
  float core = aaFill(edge) * dm;
  float e0 = max(edge, 0.0);
  // two falloffs: a tight bright one and a wide dim one
  float halo = (exp(-e0 / max(u_glow, 0.001)) * 0.62 + exp(-e0 / max(u_glow * 2.6, 0.001)) * 0.4) * u_halo;
  // slow shimmer along idle wires
  float sh = 1.0 - u_shimmer * (0.5 + 0.5 * sin(bt * 9.0 - u_time * 0.8 + u_seed * 6.28));
  // a travelling bright segment on wires feeding running steps
  float q = fract(bt * 2.0 - u_time * 0.55 + u_seed);
  float pulse = u_flow * pow(1.0 - q, 3.2) * smoothstep(0.0, 0.03, q);
  float k = sh * (1.0 + pulse * 1.4);
  vec3 hot = mix(u_col, vec3(1.0), 0.18 * core + 0.4 * pulse);
  float a = clamp(core * u_bright * k, 0.0, 1.0);
  float g = halo * (0.7 + pulse * 1.3) * sh * mix(1.0, 0.25 + 0.75 * dm, u_dash);
  if (u_additive > 0.5) {
    // dark theme: light adds up where wires and halos overlap (kept a valid premultiplied colour)
    float al = clamp(max(a, g * 0.8), 0.0, 1.0);
    o = vec4(min(hot * a + u_col * g, vec3(al)), al);
  } else {
    // light theme: a plain, subtler tint
    float al = clamp(max(a, g * 0.6), 0.0, 1.0);
    o = vec4(u_col * al, al);
  }
}`;

export interface WireDraw {
  /** Bezier control points in canvas CSS pixels. */
  p: readonly [Pt, Pt, Pt, Pt];
  color: RGB;
  bright: number;
  glow: number;
  halo: number;
  core: number;
  shimmer: number;
  flow: boolean;
  /** 0..1, differs per wire so shimmers don't line up. */
  seed: number;
  /** Drawn dashed. */
  dash?: boolean;
}

export interface WireFrame {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  /** Seconds. */
  time: number;
  additive: boolean;
}

/** True when this environment can create a WebGL2 context at all. */
export function glSupported(): boolean {
  return typeof WebGL2RenderingContext !== "undefined";
}

export class WireGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;

  /** Throws when WebGL2 isn't available (the caller falls back to SVG). */
  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas, { alpha: true });
    const gl = this.gl;
    this.prog = new Program(gl, VS, FS, { a_pos: 0 });
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    this.buf = gl.createBuffer() as WebGLBuffer;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Matches the backing store to the CSS size and device pixel ratio. */
  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  draw(wires: readonly WireDraw[], f: WireFrame): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (wires.length === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const s = f.dpr;
    this.prog.use().f2("u_res", w, h).f1("u_time", f.time).f1("u_additive", f.additive ? 1 : 0);
    gl.bindVertexArray(this.vao);
    for (const wire of wires) {
      const pts = wire.p.map((q) => ({ x: q.x * s, y: q.y * s }));
      const pad = (wire.glow * 8 + wire.core + 4) * s;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const q of pts) {
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x);
        y1 = Math.max(y1, q.y);
      }
      // Skip wires wholly outside the canvas.
      if (x1 + pad < 0 || y1 + pad < 0 || x0 - pad > w || y0 - pad > h) continue;
      const [a, b, c, d] = pts as [Pt, Pt, Pt, Pt];
      this.prog
        .f4("u_box", x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        .f2("u_p0", a.x, a.y)
        .f2("u_p1", b.x, b.y)
        .f2("u_p2", c.x, c.y)
        .f2("u_p3", d.x, d.y)
        .f3("u_col", wire.color)
        .f1("u_core", wire.core * s)
        .f1("u_glow", wire.glow * s)
        .f1("u_halo", wire.halo)
        .f1("u_bright", wire.bright)
        .f1("u_shimmer", wire.shimmer)
        .f1("u_flow", wire.flow ? 1 : 0)
        .f1("u_seed", wire.seed)
        .f1("u_dash", wire.dash ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    this.prog.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buf);
    // No loseContext(): React (StrictMode, remounts) may create a new WireGL on
    // the same <canvas>, and a lost context there stays lost (and paints white).
    // The context goes away with the element.
  }
}
