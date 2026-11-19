/**
 * Drawing one clip (Phase 9 SPEC §8.5). The CPU side is pure and tested:
 * fit geometry, transform and mask evaluation, Catmull-Rom path subdivision,
 * post parameter resolution. `ClipRenderer` is the thin GL layer over the
 * shaders in shaders.ts.
 */
import { FULLSCREEN_VS, Program, type Fullscreen, type Target } from "../gl/core";
import type { ParamSpec, ParamValues } from "../layers/registry";
import type { RGB } from "../palette";
import type { FitMode } from "./compile";
import { BLUR_FS, CLIP_FS, FITBG_FS } from "./shaders";
import { evalEditParam, type ParamContext } from "./params";
import { CROP_RULES, TRANSFORM_RULES } from "./schema";
import type { ClipTransform, EditParam, Mask } from "./types";

export const MAX_MASKS = 4;
export const MAX_PATH_POINTS = 32;

// ---- fit ----

export interface Fit {
  /** The clip's drawn rect (px). Masks and bars live in it. */
  box: [number, number];
  /** The image's rect inside the box (px). */
  img: [number, number];
}

/** Fit geometry for a source of srcW × srcH in a W × H frame (SPEC §8.5). */
export function fitGeometry(fit: FitMode, srcW: number, srcH: number, W: number, H: number): Fit {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  if (fit === "fill") {
    const s = Math.max(W / sw, H / sh);
    return { box: [sw * s, sh * s], img: [sw * s, sh * s] };
  }
  const s = Math.min(W / sw, H / sh);
  return { box: [W, H], img: [sw * s, sh * s] };
}

/** The cover-scaled size of a source over the frame (the blurred fit background). */
export function coverSize(srcW: number, srcH: number, W: number, H: number): [number, number] {
  const s = Math.max(W / Math.max(1, srcW), H / Math.max(1, srcH));
  return [Math.max(1, srcW) * s, Math.max(1, srcH) * s];
}

// ---- transform ----

export interface TransformValues {
  /** Pixels, y down. */
  offX: number;
  offY: number;
  scale: number;
  /** Radians, clockwise on screen. */
  rot: number;
  opacity: number;
  /** Crop from the left, right, top and bottom edge as fractions of the picture (0 = none). */
  crop: [number, number, number, number];
}

export function evalTransform(t: ClipTransform, W: number, H: number, clipMs: number, songMs: number, ctx: ParamContext | null): TransformValues {
  const r = TRANSFORM_RULES;
  const v = (k: keyof typeof TRANSFORM_RULES) => evalEditParam(t[k], r[k].min, r[k].max, clipMs, songMs, ctx);
  const c = t.crop;
  const cv = (p: EditParam) => evalEditParam(p, CROP_RULES.min, CROP_RULES.max, clipMs, songMs, ctx);
  const crop: [number, number, number, number] = c ? [cv(c.l), cv(c.r), cv(c.t), cv(c.b)] : [0, 0, 0, 0];
  return { offX: v("x") * W, offY: v("y") * H, scale: v("scale"), rot: (v("rotation") * Math.PI) / 180, opacity: v("opacity"), crop };
}

// ---- crop (Phase 21 SPEC §B4): applied to the picture before masks and the transform ----

type CropV = readonly [number, number, number, number];

/** The kept part of the picture in its own UV (0..1, y down). */
export function cropRect(crop: CropV): { u0: number; v0: number; u1: number; v1: number } {
  return { u0: crop[0], v0: crop[2], u1: 1 - crop[1], v1: 1 - crop[3] };
}

/**
 * Coverage (0..1) of the crop at a picture point `ri` (0..1), anti-aliased over
 * one output pixel: `imgPx` is the picture's drawn size and `scale` the clip's
 * scale. Mirrors `cropCover` in shaders.ts; 1 everywhere when nothing is cropped.
 */
export function cropCoverage(ri: readonly [number, number], crop: CropV, imgPx: readonly [number, number], scale: number): number {
  if (crop.every((c) => c === 0)) return 1;
  const lo = [(ri[0] - crop[0]) * imgPx[0] * scale + 0.5, (ri[1] - crop[2]) * imgPx[1] * scale + 0.5];
  const hi = [(1 - crop[1] - ri[0]) * imgPx[0] * scale + 0.5, (1 - crop[3] - ri[1]) * imgPx[1] * scale + 0.5];
  return Math.max(0, Math.min(1, Math.min(...lo, ...hi)));
}

// ---- masks ----

/** Closed Catmull-Rom through the points, at most `maxSeg` segments in total. */
export function subdividePath(points: ReadonlyArray<readonly [number, number]>, smooth: boolean, maxSeg = MAX_PATH_POINTS): Array<[number, number]> {
  const n = points.length;
  if (!smooth || n < 3) return points.slice(0, maxSeg).map(([x, y]) => [x, y]);
  const per = Math.max(1, Math.floor(maxSeg / n));
  const out: Array<[number, number]> = [];
  const at = (i: number) => points[((i % n) + n) % n] as readonly [number, number];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < per; s++) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out.slice(0, maxSeg);
}

export interface MaskUniforms {
  count: number;
  /** centre px (x, y), half size px (z, w) × 4 */
  a: Float32Array;
  /** rotation rad, feather px, invert, op × 4 */
  b: Float32Array;
  /** shape, first point, point count, 0 × 4 */
  c: Float32Array;
  /** 4 × 32 polygon points in box px */
  pts: Float32Array;
}

export function emptyMaskUniforms(): MaskUniforms {
  return { count: 0, a: new Float32Array(16), b: new Float32Array(16), c: new Float32Array(16), pts: new Float32Array(MAX_MASKS * MAX_PATH_POINTS * 2) };
}

const OPS = { add: 0, subtract: 1, intersect: 2 } as const;

/** Evaluates the masks' parameters at a time into shader uniforms (box = the clip's drawn rect in px). */
export function buildMaskUniforms(masks: readonly Mask[], box: readonly [number, number], clipMs: number, songMs: number, ctx: ParamContext | null): MaskUniforms {
  const u = emptyMaskUniforms();
  const [bw, bh] = box;
  const ev = (p: EditParam, lo: number, hi: number) => evalEditParam(p, lo, hi, clipMs, songMs, ctx);
  let ptr = 0;
  masks.slice(0, MAX_MASKS).forEach((m, i) => {
    const cx = ev(m.x, -1, 2) * bw;
    const cy = ev(m.y, -1, 2) * bh;
    const w = ev(m.w, 0, 2);
    const h = ev(m.h, 0, 2);
    const rot = (ev(m.rotation, -3600, 3600) * Math.PI) / 180;
    u.b[i * 4] = rot;
    u.b[i * 4 + 1] = Math.max(1, m.feather * Math.min(bw, bh));
    u.b[i * 4 + 2] = m.invert ? 1 : 0;
    u.b[i * 4 + 3] = OPS[m.op];
    if (m.shape === "path" && m.points && m.points.length >= 3) {
      const poly = subdividePath(m.points, m.smooth === true);
      const cs = Math.cos(rot);
      const sn = Math.sin(rot);
      u.c[i * 4] = 2;
      u.c[i * 4 + 1] = ptr;
      u.c[i * 4 + 2] = poly.length;
      for (const [px, py] of poly) {
        const lx = (px - 0.5) * w * bw;
        const ly = (py - 0.5) * h * bh;
        u.pts[ptr * 2] = cx + cs * lx - sn * ly;
        u.pts[ptr * 2 + 1] = cy + sn * lx + cs * ly;
        ptr++;
      }
      u.a[i * 4] = cx;
      u.a[i * 4 + 1] = cy;
    } else {
      u.c[i * 4] = m.shape === "ellipse" ? 1 : 0;
      u.a[i * 4] = cx;
      u.a[i * 4 + 1] = cy;
      u.a[i * 4 + 2] = (w * bw) / 2;
      u.a[i * 4 + 3] = (h * bh) / 2;
    }
    u.count = i + 1;
  });
  return u;
}

// ---- post parameters ----

/** Resolves a post's parameters: numbers through evalEditParam, everything else as given (or the default). */
export function resolvePostParams(specs: Record<string, ParamSpec>, raw: Record<string, EditParam | string | boolean>, clipMs: number, songMs: number, ctx: ParamContext | null): ParamValues {
  const out: ParamValues = {};
  for (const [k, spec] of Object.entries(specs)) {
    const v = raw[k];
    if (spec.kind === "number") out[k] = evalEditParam(v === undefined || typeof v === "string" || typeof v === "boolean" ? spec.default : v, spec.min, spec.max, clipMs, songMs, ctx);
    else if (spec.kind === "bool") out[k] = typeof v === "boolean" ? v : spec.default;
    else out[k] = typeof v === "string" ? v : spec.default;
  }
  return out;
}

// ---- GL ----

export interface TexEntry {
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface MatteDraw {
  tex0: TexEntry;
  tex1: TexEntry | null;
  w: number;
  invert: boolean;
  cutout: boolean;
  /** 0..1 (→ 0..1 % of the short side). */
  feather: number;
  /** Px at a 1080 short side. */
  strokePx: number;
  strokeColor: RGB;
  glowAmount: number;
  glowColor: RGB;
}

export interface ClipDraw {
  frameW: number;
  frameH: number;
  kind: "image" | "color";
  src0?: TexEntry;
  src1?: TexEntry | null;
  /** Weight of src1. */
  blend?: number;
  flip: boolean;
  color: RGB;
  fit: FitMode;
  fitColor: RGB;
  geo: Fit;
  tr: TransformValues;
  masks: MaskUniforms | null;
  matte: MatteDraw | null;
  /** 0 whole, 1 subject only, 2 background only. */
  part: 0 | 1 | 2;
  /** Stroke and glow wanted (cut-out, or effects on the subject). */
  decor: boolean;
  /** The blurred fit background (half-size target), for fit-blur. */
  bg: Target | null;
  /** Part B: src0 is a generated target (text/visual clips): premultiplied and bottom-up. */
  generated?: boolean;
  /** Part B: mirror the picture past its edges (ClipTransform.edges). */
  edges?: "clear" | "mirror";
}

export class ClipRenderer {
  private readonly clip: Program;
  private readonly cover: Program;
  private readonly blurP: Program;
  private readonly dummy: WebGLTexture;

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly fs: Fullscreen,
  ) {
    this.clip = new Program(gl, FULLSCREEN_VS, CLIP_FS);
    this.cover = new Program(gl, FULLSCREEN_VS, FITBG_FS);
    this.blurP = new Program(gl, FULLSCREEN_VS, BLUR_FS);
    this.dummy = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** The cover-scaled source into `target` (half size), before blurring. */
  drawCover(target: Target, src0: TexEntry, src1: TexEntry | null, blend: number, flip: boolean, srcW: number, srcH: number, frameW: number, frameH: number): void {
    const gl = this.gl;
    const [cw, ch] = coverSize(srcW, srcH, frameW, frameH);
    target.bind();
    gl.disable(gl.BLEND);
    this.cover
      .use()
      .tex("u_src", 0, src0.tex)
      .tex("u_src2", 1, (src1 ?? src0).tex)
      .f1("u_blend", src1 ? blend : 0)
      .f1("u_flip", flip ? 1 : 0)
      .f2("u_frame", frameW, frameH)
      .f2("u_cover", cw, ch);
    this.fs.draw();
  }

  /** One blur pass of src into dst; (dx, dy) is the step in source texels. */
  blur(src: Target, dst: Target, dx: number, dy: number): void {
    dst.bind();
    this.gl.disable(this.gl.BLEND);
    this.blurP.use().tex("u_src", 0, src.tex).f2("u_step", dx / src.w, dy / src.h);
    this.fs.draw();
  }

  /** Draws a clip into `target` (premultiplied, over a transparent clear done by the caller). */
  draw(target: Target, d: ClipDraw): void {
    const gl = this.gl;
    const p = this.clip.use();
    const m = d.matte;
    p.tex("u_src", 0, (d.src0 ?? { tex: this.dummy }).tex)
      .tex("u_src2", 1, (d.src1 ?? d.src0 ?? { tex: this.dummy }).tex)
      .tex("u_matte", 2, m ? m.tex0.tex : this.dummy)
      .tex("u_matte2", 3, m ? (m.tex1 ?? m.tex0).tex : this.dummy)
      .tex("u_bg", 4, d.bg ? d.bg.tex : this.dummy);
    const { geo, tr } = d;
    const short = Math.min(d.frameW, d.frameH);
    const outScale = short / 1080;
    p.f2("u_frame", d.frameW, d.frameH)
      .f2("u_box", geo.box[0], geo.box[1])
      .f2("u_img", geo.img[0], geo.img[1])
      .f2("u_off", tr.offX, tr.offY)
      .f1("u_scale", tr.scale)
      .f1("u_rot", tr.rot)
      .f1("u_opacity", tr.opacity)
      .f1("u_flip", d.flip ? 1 : 0)
      .i1("u_kind", d.kind === "color" ? 1 : 0)
      .f3("u_color", d.color)
      .i1("u_fit", d.fit === "fill" ? 0 : d.fit === "fit" ? 1 : d.fit === "fit-color" ? 2 : 3)
      .f3("u_fitColor", d.fitColor)
      .f1("u_blend", d.src1 && d.blend ? d.blend : 0)
      .i1("u_part", d.part)
      .f1("u_decor", d.decor ? 1 : 0)
      .i1("u_hasMatte", m ? 1 : 0)
      .f1("u_mblend", m && m.tex1 ? m.w : 0)
      .f1("u_minv", m?.invert ? 1 : 0)
      .f1("u_cutout", m?.cutout ? 1 : 0)
      .i1("u_gen", d.generated ? 1 : 0)
      .i1("u_edges", d.edges === "mirror" ? 1 : 0)
      .f4("u_crop", tr.crop[0], tr.crop[1], tr.crop[2], tr.crop[3]);
    const uvr = (px: number): [number, number] => (px <= 0 ? [0, 0] : [px / (geo.img[0] * tr.scale), px / (geo.img[1] * tr.scale)]);
    const fe = uvr(m ? m.feather * 0.01 * short : 0);
    const sk = uvr(m ? m.strokePx * outScale : 0);
    const gl2 = uvr(m && m.glowAmount > 0 ? (m.strokePx + 6) * outScale : 0);
    p.f2("u_featherUV", fe[0], fe[1])
      .f2("u_strokeUV", sk[0], sk[1])
      .f2("u_glowUV", gl2[0], gl2[1])
      .f1("u_strokeOn", m && m.strokePx > 0 ? 1 : 0)
      .f3("u_strokeColor", m?.strokeColor ?? [0, 0, 0])
      .f1("u_glowAmt", m?.glowAmount ?? 0)
      .f3("u_glowColor", m?.glowColor ?? [0, 0, 0]);
    this.setMasks(p, d.masks);
    target.bind();
    gl.disable(gl.BLEND);
    this.fs.draw();
  }

  /** Sets the mask uniforms of a program that includes GLSL_MASKS. */
  setMasks(p: Program, mk: MaskUniforms | null): void {
    const gl = this.gl;
    const u = mk ?? emptyMaskUniforms();
    p.i1("u_mcount", u.count);
    if (u.count > 0) {
      gl.uniform4fv(p.loc("u_mA"), u.a);
      gl.uniform4fv(p.loc("u_mB"), u.b);
      gl.uniform4fv(p.loc("u_mC"), u.c);
      gl.uniform2fv(p.loc("u_pts"), u.pts);
    }
  }

  dispose(): void {
    this.clip.dispose();
    this.cover.dispose();
    this.blurP.dispose();
    this.gl.deleteTexture(this.dummy);
  }
}
