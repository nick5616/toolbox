/**
 * WebGL2 basics for the engine (SPEC.md §6.5): context, cached programs,
 * HDR render targets and the fullscreen triangle. Works on a DOM canvas
 * (preview) and an OffscreenCanvas in a worker (export).
 */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export class GLUnavailableError extends Error {
  constructor(readonly gpu: string) {
    super("This computer's graphics can't run the visualizer");
  }
}

export function createContext(canvas: AnyCanvas, opts: { alpha: boolean; preserve?: boolean }): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    alpha: opts.alpha,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: opts.preserve ?? false,
    powerPreference: "high-performance",
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new GLUnavailableError("no WebGL2");
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) {
    throw new GLUnavailableError(gpuName(gl));
  }
  gl.getExtension("OES_texture_float_linear");
  return gl;
}

export function gpuName(gl: WebGL2RenderingContext): string {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown GPU";
}

/** The vertex shader of every fullscreen pass: `uv` 0..1, `p` -1..1. */
export const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 uv;
void main() { uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

export class Program {
  readonly prog: WebGLProgram;
  private readonly locs = new Map<string, WebGLUniformLocation | null>();

  constructor(
    readonly gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
    attribs: Record<string, number> = { a_pos: 0 },
  ) {
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? "";
        gl.deleteShader(s);
        throw new Error(`Shader compile failed: ${log}`);
      }
      return s;
    };
    const p = gl.createProgram() as WebGLProgram;
    const v = mk(gl.VERTEX_SHADER, vs);
    const f = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p) ?? ""}`);
    this.prog = p;
  }

  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }
  loc(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }
  f1(n: string, x: number): this {
    this.gl.uniform1f(this.loc(n), x);
    return this;
  }
  f2(n: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(n), x, y);
    return this;
  }
  f3(n: string, v: readonly [number, number, number]): this {
    this.gl.uniform3f(this.loc(n), v[0], v[1], v[2]);
    return this;
  }
  f4(n: string, x: number, y: number, z: number, w: number): this {
    this.gl.uniform4f(this.loc(n), x, y, z, w);
    return this;
  }
  i1(n: string, x: number): this {
    this.gl.uniform1i(this.loc(n), x);
    return this;
  }
  fv(n: string, v: Float32Array): this {
    this.gl.uniform1fv(this.loc(n), v);
    return this;
  }
  /** Binds a texture to a unit and points a sampler at it. */
  tex(n: string, unit: number, t: WebGLTexture | null): this {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
    this.gl.uniform1i(this.loc(n), unit);
    return this;
  }
  dispose(): void {
    this.gl.deleteProgram(this.prog);
  }
}

/** A colour render target (RGBA16F for HDR, RGBA8 otherwise). */
export class Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  constructor(
    readonly gl: WebGL2RenderingContext,
    public w: number,
    public h: number,
    readonly hdr = true,
  ) {
    this.tex = gl.createTexture() as WebGLTexture;
    this.fb = gl.createFramebuffer() as WebGLFramebuffer;
    this.alloc();
  }
  private alloc(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.w, this.h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
  }
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.alloc();
  }
  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fb);
    this.gl.viewport(0, 0, this.w, this.h);
  }
  clear(r = 0, g = 0, b = 0, a = 0): void {
    this.bind();
    this.gl.clearColor(r, g, b, a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
  dispose(): void {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fb);
  }
}

/** One VAO holding the fullscreen triangle at attribute 0. */
export class Fullscreen {
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  constructor(readonly gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    this.buf = gl.createBuffer() as WebGLBuffer;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  draw(): void {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this.gl.bindVertexArray(null);
  }
  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.buf);
  }
}

/** Uploads an image (cover art, background) as a texture. */
export function uploadImage(gl: WebGL2RenderingContext, img: TexImageSource): WebGLTexture {
  const t = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
