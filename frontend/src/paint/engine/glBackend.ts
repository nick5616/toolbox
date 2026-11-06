// The WebGL2 GLBackend: tile textures with framebuffers, instanced dab quads,
// the blend/merge pass and the view. Surfaces are RGBA8 premultiplied; row 0
// is the top everywhere (nothing is flipped). shaders.ts holds the GLSL.

import type { BlendParams, DabBatch, DabStyle, GLBackend, MaskTex, MergeParams, PresentArgs, Surface, TipStyle } from "./gl";
import { DAB_STRIDE } from "./gl";
import type { MaskData } from "./dabmath";
import { BLEND_FS, DAB_FS, DAB_VS, FULL_VS, PRESENT_FS, PRESENT_VS } from "./shaders";
import { PaintGLError } from "./types";

interface GLSurface extends Surface {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}
interface GLMask extends MaskData {
  tex: WebGLTexture;
}

const T = 512;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new PaintGLError(`Paint+ shader failed to compile: ${gl.getShaderInfoLog(s) ?? ""}`);
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram() as WebGLProgram;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new PaintGLError(`Paint+ shader failed to link: ${gl.getProgramInfoLog(p) ?? ""}`);
  return p;
}

export function createGLBackend(canvas: HTMLCanvasElement): GLBackend {
  const ctx = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!ctx) throw new PaintGLError();
  const gl: WebGL2RenderingContext = ctx;
  const dabProg = program(gl, DAB_VS, DAB_FS);
  const blendProg = program(gl, FULL_VS, BLEND_FS);
  const presentProg = program(gl, PRESENT_VS, PRESENT_FS);
  const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const U = {
    dab: Object.fromEntries(
      ["u_origin", "u_tip", "u_dual", "u_grain", "u_src", "u_tipShape", "u_dualShape", "u_hard", "u_invert", "u_aa", "u_hasDual", "u_hasGrain", "u_texturised", "u_hasSrc", "u_coverageOnly", "u_rendering", "u_dualRound", "u_grainScale", "u_grainDepth", "u_grainContrast", "u_grainTex"].map((n) => [n, loc(dabProg, n)]),
    ),
    blend: Object.fromEntries(["u_dst", "u_src", "u_sel", "u_ref", "u_mode", "u_op", "u_merge", "u_opacity", "u_wetEdges", "u_impasto", "u_hasSel", "u_hasRef"].map((n) => [n, loc(blendProg, n)])),
    present: Object.fromEntries(["u_tex", "u_doc", "u_css", "u_m0", "u_m1", "u_checker", "u_cell"].map((n) => [n, loc(presentProg, n)])),
  };

  const emptyVao = gl.createVertexArray();
  const dabVao = gl.createVertexArray();
  const dabBuf = gl.createBuffer();
  gl.bindVertexArray(dabVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, dabBuf);
  for (let i = 0; i < 4; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, 4, gl.FLOAT, false, DAB_STRIDE * 4, i * 16);
    gl.vertexAttribDivisor(i, 1);
  }
  gl.bindVertexArray(null);

  const mkSampler = (linear: boolean, repeat: boolean) => {
    const s = gl.createSampler() as WebGLSampler;
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    const w = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, w);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, w);
    return s;
  };
  const samplers = { lc: mkSampler(true, false), nc: mkSampler(false, false), lr: mkSampler(true, true), nr: mkSampler(false, true) };
  // Trilinear sampler for presenting the composite zoomed out (no shimmering staircases).
  const mipSampler = mkSampler(true, false);
  gl.samplerParameteri(mipSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  let compMipDirty = true;

  const mkTex = (w: number, h: number, fmt: number, levels = 1) => {
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const mkFbo = (tex: WebGLTexture) => {
    const f = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return f;
  };

  const spare: GLSurface[] = [];
  let comp: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;

  const bindTex = (unit: number, t: WebGLTexture | null, sampler: WebGLSampler | null = null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.bindSampler(unit, sampler);
  };
  const dummy = mkTex(1, 1, gl.RGBA8);

  const newSurface = (): GLSurface => {
    const tex = mkTex(T, T, gl.RGBA8);
    const fbo = mkFbo(tex);
    return { w: T, h: T, tex, fbo };
  };
  const g = (s: Surface) => s as GLSurface;

  function tipUniforms(prefixShape: string, hard: string, t: TipStyle, unit: number, aa: boolean, idx: 0 | 1): void {
    gl.uniform1i(U.dab[prefixShape] ?? null, t.shape === "square" ? 1 : t.shape === "image" ? 2 : t.shape === "color" ? 3 : 0);
    void hard;
    const tex = (t.shape === "image" || t.shape === "color") && t.tex ? (t.tex as GLMask).tex : dummy;
    bindTex(unit, tex, aa ? samplers.lc : samplers.nc);
    void idx;
  }

  function drawFull(): void {
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const be: GLBackend = {
    name: "webgl2",
    gl,
    tile: T,
    createSurface(): Surface {
      return spare.pop() ?? newSurface();
    },
    destroySurface(s: Surface): void {
      if (spare.length < 64) spare.push(g(s));
      else {
        gl.deleteFramebuffer(g(s).fbo);
        gl.deleteTexture(g(s).tex);
      }
    },
    clear(s: Surface): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g(s).fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    fill(s: Surface, r: number, gg: number, b: number, a: number): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g(s).fbo);
      gl.clearColor(r / 255, gg / 255, b / 255, a / 255);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    copy(dst: Surface, src: Surface): void {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, g(src).fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, g(dst).fbo);
      gl.blitFramebuffer(0, 0, T, T, 0, 0, T, T, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    },
    upload(s: Surface, data: Uint8ClampedArray, x: number, y: number, w: number, h: number): void {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g(s).tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    },
    download(s: Surface, x: number, y: number, w: number, h: number): Uint8ClampedArray {
      gl.bindFramebuffer(gl.FRAMEBUFFER, g(s).fbo);
      const out = new Uint8ClampedArray(w * h * 4);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    },
    createMask(data: Uint8Array | Uint8ClampedArray, w: number, h: number): MaskTex {
      const tex = mkTex(w, h, gl.R8);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
      const f = new Float32Array(w * h);
      for (let i = 0; i < f.length; i++) f[i] = (data[i] as number) / 255;
      return { w, h, tex, data: f } as GLMask;
    },
    createColorMask(rgba: Uint8ClampedArray, w: number, h: number): MaskTex {
      // Premultiplied in the texture so the linear filter never bleeds the colour of transparent texels.
      const pm = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = rgba[i * 4 + 3] as number;
        pm[i * 4] = Math.round(((rgba[i * 4] as number) * a) / 255);
        pm[i * 4 + 1] = Math.round(((rgba[i * 4 + 1] as number) * a) / 255);
        pm[i * 4 + 2] = Math.round(((rgba[i * 4 + 2] as number) * a) / 255);
        pm[i * 4 + 3] = a;
      }
      const tex = mkTex(w, h, gl.RGBA8);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pm);
      const alpha = new Float32Array(w * h);
      const rgb = new Float32Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        alpha[i] = (rgba[i * 4 + 3] as number) / 255;
        rgb[i * 3] = (rgba[i * 4] as number) / 255;
        rgb[i * 3 + 1] = (rgba[i * 4 + 1] as number) / 255;
        rgb[i * 3 + 2] = (rgba[i * 4 + 2] as number) / 255;
      }
      return { w, h, tex, data: alpha, rgb } as GLMask;
    },
    destroyMask(m: MaskTex): void {
      gl.deleteTexture((m as GLMask).tex);
    },

    drawDabs(dst: Surface, ox: number, oy: number, batch: DabBatch, style: DabStyle, source: Surface | null, clip: { x: number; y: number; w: number; h: number }): void {
      const n = batch.end - batch.start;
      if (n <= 0) return;
      const sx0 = Math.max(0, clip.x - ox);
      const sy0 = Math.max(0, clip.y - oy);
      const sx1 = Math.min(T, clip.x + clip.w - ox);
      const sy1 = Math.min(T, clip.y + clip.h - oy);
      if (sx1 <= sx0 || sy1 <= sy0) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, g(dst).fbo);
      gl.viewport(0, 0, T, T);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);
      gl.enable(gl.BLEND);
      if (style.rendering === 1) {
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.useProgram(dabProg);
      const u = U.dab;
      const aa = style.antialias;
      gl.uniform2f(u.u_origin ?? null, ox, oy);
      tipUniforms("u_tipShape", "u_hard", style.tip, 0, aa, 0);
      gl.uniform1i(u.u_tip ?? null, 0);
      gl.uniform1i(u.u_aa ?? null, aa ? 1 : 0);
      const dual = style.dual;
      gl.uniform1i(u.u_hasDual ?? null, dual ? 1 : 0);
      if (dual) tipUniforms("u_dualShape", "u_hard", dual, 1, aa, 1);
      else bindTex(1, dummy, samplers.nc);
      gl.uniform1i(u.u_dual ?? null, 1);
      gl.uniform2f(u.u_hard ?? null, style.tip.hardness, dual ? dual.hardness : 1);
      gl.uniform2i(u.u_invert ?? null, style.tip.invert ? 1 : 0, dual?.invert ? 1 : 0);
      gl.uniform1f(u.u_dualRound ?? null, dual ? dual.roundness : 1);
      const gr = style.grain && style.grain.tex ? style.grain : null;
      gl.uniform1i(u.u_hasGrain ?? null, gr ? 1 : 0);
      if (gr) {
        bindTex(2, (gr.tex as GLMask).tex, aa ? samplers.lr : samplers.nr);
        gl.uniform1i(u.u_texturised ?? null, gr.texturised ? 1 : 0);
        gl.uniform1f(u.u_grainScale ?? null, gr.scale);
        gl.uniform1f(u.u_grainDepth ?? null, gr.depth);
        gl.uniform1f(u.u_grainContrast ?? null, gr.contrast);
        gl.uniform2f(u.u_grainTex ?? null, (gr.tex as GLMask).w, (gr.tex as GLMask).h);
      } else bindTex(2, dummy, samplers.nr);
      gl.uniform1i(u.u_grain ?? null, 2);
      gl.uniform1i(u.u_hasSrc ?? null, source ? 1 : 0);
      bindTex(3, source ? g(source).tex : dummy, null);
      gl.uniform1i(u.u_src ?? null, 3);
      gl.uniform1i(u.u_coverageOnly ?? null, style.coverageOnly ? 1 : 0);
      gl.uniform1i(u.u_rendering ?? null, style.rendering);
      gl.bindVertexArray(dabVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, dabBuf);
      gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(batch.start * DAB_STRIDE, batch.end * DAB_STRIDE), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.SCISSOR_TEST);
      for (let i = 0; i < 4; i++) gl.bindSampler(i, null);
    },

    mergeScratch(layer: Surface, scratch: Surface, p: MergeParams): void {
      runBlend(layer, scratch, 1, p.op === "over" ? 0 : p.op === "atop" ? 1 : p.op === "erase" ? 2 : 3, p.mode, p.opacity, p.wetEdges, p.impasto, p.selection, p.source);
    },

    blend(dst: Surface, src: Surface, p: BlendParams): void {
      runBlend(dst, src, 0, p.atop ? 1 : 0, p.mode, p.opacity, 0, 0, null, null);
    },

    uploadAlpha(s: Surface, mask: Uint8Array, x: number, y: number, w: number, h: number): void {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = mask[i] as number;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g(s).tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    },

    resizeComposite(w: number, h: number): void {
      if (comp) {
        gl.deleteFramebuffer(comp.fbo);
        gl.deleteTexture(comp.tex);
      }
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (w > max || h > max) throw new PaintGLError(`This canvas is larger than the graphics card supports (${max} px)`);
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      const tex = mkTex(w, h, gl.RGBA8, levels);
      comp = { tex, fbo: mkFbo(tex), w, h };
      compMipDirty = true;
      const lin = samplers.lc;
      void lin;
    },
    storeComposite(tile: Surface, x: number, y: number, w: number, h: number): void {
      if (!comp) return;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, g(tile).fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, comp.fbo);
      gl.blitFramebuffer(0, 0, w, h, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      compMipDirty = true;
    },
    readComposite(): Uint8ClampedArray {
      if (!comp) return new Uint8ClampedArray(0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, comp.fbo);
      const out = new Uint8ClampedArray(comp.w * comp.h * 4);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, comp.w, comp.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    },
    present(a: PresentArgs): void {
      if (!comp) return;
      const c = a.canvas;
      const dpr = c.clientWidth > 0 ? c.width / c.clientWidth : 1;
      void dpr;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, c.width, c.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(presentProg);
      const u = U.present;
      gl.uniform2f(u.u_doc ?? null, a.docW, a.docH);
      gl.uniform2f(u.u_css ?? null, a.cssW, a.cssH);
      const m = a.matrix;
      gl.uniform3f(u.u_m0 ?? null, m[0], m[2], m[4]);
      gl.uniform3f(u.u_m1 ?? null, m[1], m[3], m[5]);
      gl.uniform1f(u.u_cell ?? null, 8 / Math.max(0.01, Math.hypot(m[0], m[1])));
      const scale = Math.hypot(m[0], m[1]) * (c.clientWidth > 0 ? c.width / c.clientWidth : 1);
      if (!a.nearest && scale < 1) {
        if (compMipDirty) {
          gl.bindTexture(gl.TEXTURE_2D, comp.tex);
          gl.generateMipmap(gl.TEXTURE_2D);
          compMipDirty = false;
        }
        bindTex(0, comp.tex, mipSampler);
      } else bindTex(0, comp.tex, a.nearest ? samplers.nc : samplers.lc);
      gl.uniform1i(u.u_tex ?? null, 0);
      gl.bindVertexArray(emptyVao);
      if (a.checker) {
        gl.uniform1i(u.u_checker ?? null, 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.uniform1i(u.u_checker ?? null, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
      gl.bindSampler(0, null);
    },
    dispose(): void {
      for (const s of spare) {
        gl.deleteFramebuffer(s.fbo);
        gl.deleteTexture(s.tex);
      }
      spare.length = 0;
      gl.deleteProgram(dabProg);
      gl.deleteProgram(blendProg);
      gl.deleteProgram(presentProg);
    },
  };

  /** dst = f(dst, src) through a temporary target; the two swap their textures. */
  function runBlend(dst: Surface, src: Surface, merge: number, op: number, mode: number, opacity: number, wetEdges: number, impasto: number, sel: Surface | null, ref: Surface | null): void {
    const tmp = (spare.pop() ?? newSurface()) as GLSurface;
    const d = g(dst);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo);
    gl.viewport(0, 0, T, T);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(blendProg);
    const u = U.blend;
    bindTex(0, d.tex);
    bindTex(1, g(src).tex);
    bindTex(2, sel ? g(sel).tex : dummy);
    bindTex(3, ref ? g(ref).tex : dummy);
    gl.uniform1i(u.u_dst ?? null, 0);
    gl.uniform1i(u.u_src ?? null, 1);
    gl.uniform1i(u.u_sel ?? null, 2);
    gl.uniform1i(u.u_ref ?? null, 3);
    gl.uniform1i(u.u_mode ?? null, mode);
    gl.uniform1i(u.u_op ?? null, op);
    gl.uniform1i(u.u_merge ?? null, merge);
    gl.uniform1f(u.u_opacity ?? null, opacity);
    gl.uniform1f(u.u_wetEdges ?? null, wetEdges);
    gl.uniform1f(u.u_impasto ?? null, impasto);
    gl.uniform1i(u.u_hasSel ?? null, sel ? 1 : 0);
    gl.uniform1i(u.u_hasRef ?? null, ref ? 1 : 0);
    drawFull();
    // Swap storage: dst now owns the result, tmp the old content (recycled).
    const t = d.tex;
    const f = d.fbo;
    d.tex = tmp.tex;
    d.fbo = tmp.fbo;
    tmp.tex = t;
    tmp.fbo = f;
    spare.push(tmp);
  }

  return be;
}
