/**
 * Thick anti-aliased polylines (SPEC.md §6.5): a polyline of any length with a
 * per-vertex width and colour is tessellated into a triangle strip whose
 * fragment shader evaluates the distance to the centre line, so edges are
 * analytically anti-aliased, ends are round, and glow is a soft SDF falloff.
 * Used by the L2 shape layers (ribbons, rings, helix, highway, ...).
 *
 * Usage per frame: begin(glowPx, hot); then for each line start(closed),
 * add(x, y, halfWidth, r, g, b, a) ..., end(); then draw(w, h). Coordinates are
 * pixels, y down. Colours are linear, premultiplied by the shader.
 */
import { GLSL_COMMON } from "./glsl";
import { Program } from "./core";

const VERT_FLOATS = 9; // pos2, info3 (d, halfWidth, endDistance), color4
const PT_FLOATS = 7; // x, y, hw, r, g, b, a
const SEC_FLOATS = VERT_FLOATS * 2;

const VS = `#version 300 es
in vec2 a_pos; in vec3 a_info; in vec4 a_color;
uniform vec2 u_res;
out vec3 v_info; out vec4 v_color;
void main() {
  v_info = a_info; v_color = a_color;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_info; in vec4 v_color;
out vec4 o;
${GLSL_COMMON}
uniform float u_glow; uniform float u_hot;
void main() {
  float d = length(vec2(max(v_info.z, 0.0), v_info.x)) - v_info.y;
  float a = aaFill(d) + glowFalloff(d, u_glow) * 0.6;
  float core = aaFill(d + v_info.y * 0.55);
  vec3 rgb = v_color.rgb + core * u_hot * (0.28 + v_color.rgb * 0.45);
  o = vec4(rgb * v_color.a * a, v_color.a * a);
}`;

export class LineBatch {
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  private verts: Float32Array;
  private nv = 0;
  private pts = new Float32Array(PT_FLOATS * 256);
  private np = 0;
  private closed = false;
  private flat = false;
  private horiz = false;
  private secs = new Float32Array(SEC_FLOATS * 260);
  private ns = 0;
  private pad = 2;
  private glow = 0;
  private hot = 0.5;

  constructor(
    readonly gl: WebGL2RenderingContext,
    capacityVerts = 16384,
  ) {
    this.prog = new Program(gl, VS, FS, { a_pos: 0, a_info: 1, a_color: 2 });
    this.verts = new Float32Array(capacityVerts * VERT_FLOATS);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    this.buf = gl.createBuffer() as WebGLBuffer;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = VERT_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
  }

  /** Starts a new batch. glowPx is the glow radius in pixels, hot the brightness of the white-hot core (0..1). */
  begin(glowPx = 0, hot = 0.5): void {
    this.nv = 0;
    this.np = 0;
    this.glow = glowPx;
    this.hot = hot;
    this.pad = glowPx * 4 + 1.5;
  }

  /**
   * Starts a polyline. `flat` ends it square at the first and last point instead of rounding it.
   * `horizontal` (for near-vertical lines, with flat ends) widens the line sideways so its ends are
   * horizontal and the half-width is the horizontal one: a trapezoid when the width changes along it.
   */
  start(closed = false, flat = false, horizontal = false): void {
    this.np = 0;
    this.closed = closed;
    this.flat = flat;
    this.horiz = horizontal;
  }

  add(x: number, y: number, hw: number, r: number, g: number, b: number, a: number): void {
    if (this.np * PT_FLOATS + PT_FLOATS > this.pts.length) {
      const bigger = new Float32Array(this.pts.length * 2);
      bigger.set(this.pts);
      this.pts = bigger;
    }
    const o = this.np * PT_FLOATS;
    const p = this.pts;
    p[o] = x; p[o + 1] = y; p[o + 2] = hw; p[o + 3] = r; p[o + 4] = g; p[o + 5] = b; p[o + 6] = a;
    this.np++;
  }

  /** Tessellates the polyline started with start(). */
  end(): void {
    const n = this.np;
    this.np = 0;
    if (n < 2) return;
    const p = this.pts;
    const closed = this.closed && n > 2;
    this.ns = 0;
    const growSecs = () => {
      if ((this.ns + 1) * SEC_FLOATS > this.secs.length) {
        const bigger = new Float32Array(this.secs.length * 2);
        bigger.set(this.secs);
        this.secs = bigger;
      }
    };
    const section = (x: number, y: number, nx: number, ny: number, mit: number, hw: number, e: number, k: number, innerSide = 0, innerMax = 1e9) => {
      growSecs();
      const s = this.secs;
      const o = this.ns * SEC_FLOATS;
      const ext = hw + this.pad;
      const off = ext * mit;
      if (this.horiz) {
        const ds = Math.max(0.2, Math.abs(nx));
        for (let side = 0; side < 2; side++) {
          const sg = side === 0 ? 1 : -1;
          const v = o + side * VERT_FLOATS;
          s[v] = x + sg * (hw + this.pad / ds);
          s[v + 1] = y;
          s[v + 2] = sg * (hw * ds + this.pad);
          s[v + 3] = hw * ds;
          s[v + 4] = 0;
          s[v + 5] = p[k + 3] as number;
          s[v + 6] = p[k + 4] as number;
          s[v + 7] = p[k + 5] as number;
          s[v + 8] = p[k + 6] as number;
        }
        this.ns++;
        return;
      }
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? 1 : -1;
        const v = o + side * VERT_FLOATS;
        // on the inside of a tight bend the offset would fold over itself: clamp it and compress the distance to match
        const used = sg === innerSide ? Math.min(off, innerMax) : off;
        s[v] = x + nx * used * sg;
        s[v + 1] = y + ny * used * sg;
        s[v + 2] = sg * ext * (used / off);
        s[v + 3] = hw;
        s[v + 4] = e;
        s[v + 5] = p[k + 3] as number;
        s[v + 6] = p[k + 4] as number;
        s[v + 7] = p[k + 5] as number;
        s[v + 8] = p[k + 6] as number;
      }
      this.ns++;
    };
    let ltx = 1;
    let lty = 0;
    const tang = (i: number, j: number) => {
      const dx = (p[j * PT_FLOATS] as number) - (p[i * PT_FLOATS] as number);
      const dy = (p[j * PT_FLOATS + 1] as number) - (p[i * PT_FLOATS + 1] as number);
      const l = Math.hypot(dx, dy);
      return l < 1e-6 ? null : ([dx / l, dy / l] as const);
    };
    const caps = !closed && !this.flat;
    // Leading cap
    if (caps) {
      const t = tang(0, 1) ?? ([ltx, lty] as const);
      const hw = p[2] as number;
      const ext = hw + this.pad;
      const x = (p[0] as number) - t[0] * ext;
      const y = (p[1] as number) - t[1] * ext;
      section(x, y, -t[1], t[0], 1, hw, ext, 0); // carries the first point's colour
    }
    for (let i = 0; i < n; i++) {
      const prev = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      const next = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const t = tang(prev, next) ?? ([ltx, lty] as const);
      ltx = t[0];
      lty = t[1];
      const nx = -t[1];
      const ny = t[0];
      // miter: stretch by 1 / cos(half angle) between the tangent and the adjacent segment
      const sNext = tang(i, i === n - 1 && !closed ? i : next) ?? t;
      const cosA = Math.abs(t[0] * sNext[0] + t[1] * sNext[1]);
      const mit = Math.min(1.2, 1 / Math.max(0.5, cosA));
      // bend radius from the two adjacent segments
      let innerSide = 0;
      let innerMax = 1e9;
      const tp = tang(prev, i);
      const tn = tang(i, next);
      if (tp && tn) {
        const dot = Math.max(-1, Math.min(1, tp[0] * tn[0] + tp[1] * tn[1]));
        const theta = Math.acos(dot);
        if (theta > 0.02) {
          const lp = Math.hypot((p[i * PT_FLOATS] as number) - (p[prev * PT_FLOATS] as number), (p[i * PT_FLOATS + 1] as number) - (p[prev * PT_FLOATS + 1] as number));
          const ln = Math.hypot((p[next * PT_FLOATS] as number) - (p[i * PT_FLOATS] as number), (p[next * PT_FLOATS + 1] as number) - (p[i * PT_FLOATS + 1] as number));
          innerMax = (0.5 * (lp + ln)) / (2 * Math.sin(theta / 2)) * 0.9;
          innerSide = tp[0] * tn[1] - tp[1] * tn[0] > 0 ? 1 : -1;
        }
      }
      section(p[i * PT_FLOATS] as number, p[i * PT_FLOATS + 1] as number, nx, ny, mit, p[i * PT_FLOATS + 2] as number, 0, i * PT_FLOATS, innerSide, innerMax);
    }
    // Trailing cap
    if (caps) {
      const t = tang(n - 2, n - 1) ?? ([ltx, lty] as const);
      const hw = p[(n - 1) * PT_FLOATS + 2] as number;
      const ext = hw + this.pad;
      section((p[(n - 1) * PT_FLOATS] as number) + t[0] * ext, (p[(n - 1) * PT_FLOATS + 1] as number) + t[1] * ext, -t[1], t[0], 1, hw, ext, (n - 1) * PT_FLOATS);
    }
    // Closed lines have no caps: connect the loop instead.
    const first = 0;
    const last = this.ns - 1;
    const total = (last - first) * 6 + (closed ? 6 : 0);
    if ((this.nv + total) * VERT_FLOATS > this.verts.length) {
      let size = this.verts.length;
      while ((this.nv + total) * VERT_FLOATS > size) size *= 2;
      const bigger = new Float32Array(size);
      bigger.set(this.verts.subarray(0, this.nv * VERT_FLOATS));
      this.verts = bigger;
    }
    const quad = (a: number, b: number) => {
      // sections a -> b: A0 B0 A1, B0 B1 A1
      const s = this.secs;
      const v = this.verts;
      const copy = (sec: number, side: number) => {
        const src = sec * SEC_FLOATS + side * VERT_FLOATS;
        const dst = this.nv * VERT_FLOATS;
        for (let q = 0; q < VERT_FLOATS; q++) v[dst + q] = s[src + q] as number;
        this.nv++;
      };
      copy(a, 0); copy(a, 1); copy(b, 0);
      copy(a, 1); copy(b, 1); copy(b, 0);
    };
    for (let k = first; k < last; k++) quad(k, k + 1);
    if (closed) quad(last, first);
  }

  get vertexCount(): number {
    return this.nv;
  }

  draw(w: number, h: number): void {
    if (this.nv === 0) return;
    const gl = this.gl;
    this.prog.use().f2("u_res", w, h).f1("u_glow", this.glow).f1("u_hot", this.hot);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, this.nv * VERT_FLOATS), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.nv);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.prog.dispose();
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.buf);
  }
}
