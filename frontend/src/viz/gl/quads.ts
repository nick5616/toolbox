/**
 * Instanced quads with SDF fragment shaders (SPEC.md §6.5): bars, dots, lines,
 * rings and particles are drawn as quads in pixel space, shaded by a signed
 * distance so edges are anti-aliased at any resolution.
 *
 * Per instance: rect (cx, cy, halfW, halfH) in pixels (y down), color (linear,
 * premultiplied by the shader), extra (rotation radians, then 3 free floats).
 */
import { GLSL_COMMON } from "./glsl";
import { Program } from "./core";

const FLOATS = 12;

const VS = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
in vec4 a_color;
in vec4 a_extra;
uniform vec2 u_res;
uniform float u_pad;
out vec2 v_p;
out vec2 v_half;
out vec4 v_color;
out vec4 v_extra;
void main() {
  vec2 half_ = a_rect.zw + u_pad;
  float c = cos(a_extra.x), s = sin(a_extra.x);
  vec2 local = a_corner * half_;
  vec2 world = a_rect.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  v_p = local;
  v_half = a_rect.zw;
  v_color = a_color;
  v_extra = a_extra;
  vec2 clip = world / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

/** A fragment body defining `vec4 shade(vec2 p, vec2 halfSize, vec4 color, vec4 extra)` (premultiplied out). */
export const SHADE_ROUND_BOX = `
uniform float u_glow;
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float r = min(min(h.x, h.y), extra.y);
  float d = sdRoundBox(p, h, r);
  float a = aaFill(d) + glowFalloff(d, u_glow) * 0.6;
  return vec4(color.rgb * color.a * a, color.a * a);
}`;

export const SHADE_DISC = `
uniform float u_glow;
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float d = sdCircle(p, min(h.x, h.y));
  float a = aaFill(d) + glowFalloff(d, u_glow) * 0.7;
  return vec4(color.rgb * color.a * a, color.a * a);
}`;

/** A ring: extra.y = thickness in pixels. */
export const SHADE_RING = `
uniform float u_glow;
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float d = abs(length(p) - min(h.x, h.y)) - extra.y * 0.5;
  float a = aaFill(d) + glowFalloff(d, u_glow) * 0.7;
  return vec4(color.rgb * color.a * a, color.a * a);
}`;

export class QuadBatch {
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly corner: WebGLBuffer;
  private readonly inst: WebGLBuffer;
  private data: Float32Array;
  private n = 0;

  constructor(
    readonly gl: WebGL2RenderingContext,
    shadeBody: string,
    capacity = 1024,
  ) {
    const fs = `#version 300 es
precision highp float;
in vec2 v_p; in vec2 v_half; in vec4 v_color; in vec4 v_extra;
out vec4 o;
${GLSL_COMMON}
${shadeBody}
void main() { o = shade(v_p, v_half, v_color, v_extra); }`;
    this.prog = new Program(gl, VS, fs, { a_corner: 0, a_rect: 1, a_color: 2, a_extra: 3 });
    this.data = new Float32Array(capacity * FLOATS);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    this.corner = gl.createBuffer() as WebGLBuffer;
    this.inst = gl.createBuffer() as WebGLBuffer;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const stride = FLOATS * 4;
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
  }

  /** The program, to set extra uniforms (e.g. u_glow) before draw. */
  get program(): Program {
    return this.prog;
  }

  begin(): void {
    this.n = 0;
  }

  push(cx: number, cy: number, hw: number, hh: number, r: number, g: number, b: number, a: number, rot = 0, e1 = 0, e2 = 0, e3 = 0): void {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const o = this.n * FLOATS;
    const d = this.data;
    d[o] = cx; d[o + 1] = cy; d[o + 2] = hw; d[o + 3] = hh;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = rot; d[o + 9] = e1; d[o + 10] = e2; d[o + 11] = e3;
    this.n++;
  }

  get count(): number {
    return this.n;
  }

  /** Draws the pushed quads into the bound target (w×h pixels). pad grows quads for glow. */
  draw(w: number, h: number, pad: number, setUniforms?: (p: Program) => void): void {
    if (this.n === 0) return;
    const gl = this.gl;
    this.prog.use().f2("u_res", w, h).f1("u_pad", pad);
    setUniforms?.(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * FLOATS), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.prog.dispose();
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.corner);
    this.gl.deleteBuffer(this.inst);
  }
}
