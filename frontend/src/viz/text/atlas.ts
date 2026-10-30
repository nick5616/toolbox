/**
 * The glyph atlas (SPEC.md §6.8). Each line of lyrics is rasterised once with
 * Canvas2D at the output resolution, one cell per word, into shared 2048²
 * RGBA8 pages: R = fill coverage, G = outline (strokeText), B = glow mask.
 * The three channels are drawn additively onto opaque black, so they never
 * depend on alpha handling when the canvas is uploaded.
 *
 * Words get their own cell (not one strip per line) so the shader can scale,
 * move and colour every word independently; the cells of a line are allocated
 * and released together.
 */
import { layoutWords, type LineLayout, type WordSpec } from "./layout";

export const PAGE_SIZE = 2048;
export const MAX_PAGES = 8;

// ---- packing ---------------------------------------------------------------

interface Shelf {
  y: number;
  h: number;
  x: number;
}

/** A shelf packer: rows of equal-ish height filled left to right. */
export class ShelfPacker {
  private shelves: Shelf[] = [];
  private nextY = 0;
  /** Number of rectangles currently placed. */
  count = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly gap = 1,
  ) {}

  /** Places a w×h rectangle; null when it does not fit. */
  alloc(w: number, h: number): { x: number; y: number } | null {
    const rw = w + this.gap;
    const rh = h + this.gap;
    if (w <= 0 || h <= 0 || rw > this.width || rh > this.height) return null;
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.h >= rh && s.x + rw <= this.width && (best === null || s.h < best.h)) best = s;
    }
    if (!best) {
      const sh = Math.ceil(rh / 4) * 4;
      if (this.nextY + sh > this.height) {
        const left = this.height - this.nextY;
        if (left < rh) return null;
        best = { y: this.nextY, h: left, x: 0 };
      } else best = { y: this.nextY, h: sh, x: 0 };
      this.shelves.push(best);
      this.nextY += best.h;
    }
    const pos = { x: best.x, y: best.y };
    best.x += rw;
    this.count++;
    return pos;
  }

  /** Fraction of the page area claimed by shelves (for tests and diagnostics). */
  get usedHeight(): number {
    return this.nextY;
  }

  reset(): void {
    this.shelves = [];
    this.nextY = 0;
    this.count = 0;
  }
}

// ---- raster canvas ---------------------------------------------------------

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type RasterCanvas = OffscreenCanvas | HTMLCanvasElement;

interface Surface {
  canvas: RasterCanvas;
  ctx: Ctx2D;
}

/** OffscreenCanvas when available (worker and main thread), else a DOM canvas. */
export function createSurface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d") as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D };
}

const warned = new Set<string>();
const availability = new Map<string, boolean>();

/**
 * Whether a font family renders as itself: compares the width of a probe string
 * against the generic fallbacks. Unknown families fall back to Arial.
 */
export function resolveFamily(family: string, probe: Ctx2D): string {
  const fam = family.trim();
  if (fam === "" || /^(arial|sans-serif|serif|monospace)$/i.test(fam)) return fam === "" ? "Arial" : fam;
  let ok = availability.get(fam);
  if (ok === undefined) {
    const text = "mmmmmmmmmmlliWWW@@";
    const width = (stack: string): number => {
      probe.font = `400 72px ${stack}`;
      return probe.measureText(text).width;
    };
    const quoted = `"${fam.replace(/"/g, "")}"`;
    ok = width(`${quoted}, monospace`) !== width("monospace") || width(`${quoted}, serif`) !== width("serif");
    availability.set(fam, ok);
    if (!ok && !warned.has(fam)) {
      warned.add(fam);
      console.warn(`[text] font "${fam}" is not available; using Arial`);
    }
  }
  return ok ? fam : "Arial";
}

// ---- cells -----------------------------------------------------------------

export interface Cell {
  page: number;
  /** Position and size in the page, px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Left edge of the glyph advance box inside the cell, px. */
  ox: number;
  /** Advance width of the word as rasterised, px. */
  gw: number;
  /** Baseline row inside the cell, px. */
  baseline: number;
  /** Raster scale relative to the nominal font size (emphasised words > 1). */
  rs: number;
  /** Font size the word was rasterised at, px. */
  px: number;
  /** Width of the first n characters as rasterised (typewriter), px; length = chars + 1. */
  prefix: Float32Array;
}

export interface RasterStyle {
  family: string;
  weight: number;
  uppercase: boolean;
  /** Outline thickness as a fraction of the font size. */
  outline: number;
  glow: boolean;
}

export interface LineRequest {
  words: readonly string[];
  emphasised: readonly boolean[];
  /** Nominal font size in px (already includes any size multiplier). */
  fontPx: number;
  /** Raster scale for emphasised words. */
  emphasisScale: number;
  maxWidth: number;
}

export interface LineEntry {
  key: string;
  layout: LineLayout;
  cells: Array<Cell | null>;
}

interface Page {
  tex: WebGLTexture;
  packer: ShelfPacker;
  live: number;
}

export class GlyphAtlas {
  private readonly pages: Page[] = [];
  private readonly entries = new Map<string, LineEntry>();
  private styleKey = "";
  private scratch: Surface | null = null;
  private readonly probe: Surface;
  private family = "Arial";

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.probe = createSurface(8, 8);
  }

  get pageCount(): number {
    return this.pages.length;
  }
  page(i: number): WebGLTexture | null {
    return this.pages[i]?.tex ?? null;
  }
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Drops everything when the raster-affecting style or size changed. */
  configure(styleKey: string): void {
    if (styleKey === this.styleKey) return;
    this.styleKey = styleKey;
    this.clear();
  }

  clear(): void {
    this.entries.clear();
    for (const p of this.pages) {
      p.packer.reset();
      p.live = 0;
    }
  }

  /** Releases every line whose key is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const [key, e] of this.entries) {
      if (keep.has(key)) continue;
      for (const c of e.cells) {
        if (!c) continue;
        const p = this.pages[c.page];
        if (!p) continue;
        p.live--;
        if (p.live <= 0) {
          p.live = 0;
          p.packer.reset();
        }
      }
      this.entries.delete(key);
    }
  }

  private newPage(): Page | null {
    if (this.pages.length >= MAX_PAGES) return null;
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PAGE_SIZE, PAGE_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const page: Page = { tex, packer: new ShelfPacker(PAGE_SIZE, PAGE_SIZE), live: 0 };
    this.pages.push(page);
    return page;
  }

  private alloc(w: number, h: number): { page: number; x: number; y: number } | null {
    for (let i = 0; i < this.pages.length; i++) {
      const pos = (this.pages[i] as Page).packer.alloc(w, h);
      if (pos) return { page: i, ...pos };
    }
    const p = this.newPage();
    if (!p) return null;
    const pos = p.packer.alloc(w, h);
    return pos ? { page: this.pages.length - 1, ...pos } : null;
  }

  /** The cached raster of a line, drawing it first if needed. */
  line(key: string, req: LineRequest, style: RasterStyle): LineEntry {
    const hit = this.entries.get(key);
    if (hit) return hit;
    this.family = resolveFamily(style.family, this.probe.ctx);
    const font = (px: number): string => `${style.weight} ${px}px "${this.family}", Arial, sans-serif`;
    const pctx = this.probe.ctx;
    const shown = (s: string): string => (style.uppercase ? s.toUpperCase() : s);
    pctx.font = font(req.fontPx);
    const specs: WordSpec[] = req.words.map((w, i) => ({ text: shown(w), widthScale: req.emphasised[i] ? req.emphasisScale : 1 }));
    const layout = layoutWords(specs, (s) => pctx.measureText(s).width, req.fontPx, req.maxWidth);
    const cells = specs.map((s, i) => this.rasterWord(s.text, req.fontPx * (req.emphasised[i] ? req.emphasisScale : 1), req.emphasised[i] ? req.emphasisScale : 1, style));
    const entry: LineEntry = { key, layout, cells };
    this.entries.set(key, entry);
    return entry;
  }

  private rasterWord(text: string, px: number, rs: number, style: RasterStyle): Cell | null {
    if (text === "") return null;
    const ctx = this.probe.ctx;
    const fontCss = `${style.weight} ${px}px "${this.family}", Arial, sans-serif`;
    ctx.font = fontCss;
    const m = ctx.measureText(text);
    const gw = m.width;
    const asc = Math.ceil(m.fontBoundingBoxAscent ?? px * 0.95);
    const desc = Math.ceil(m.fontBoundingBoxDescent ?? px * 0.3);
    const outlinePx = style.outline * px;
    const blur = style.glow ? 0.2 * px : 0;
    const pad = Math.ceil(outlinePx + blur * 1.25 + 0.1 * px + 2);
    const cw = Math.ceil(gw) + pad * 2;
    const ch = asc + desc + pad * 2;
    const at = this.alloc(cw, ch);
    if (!at) return null;
    const page = this.pages[at.page] as Page;
    page.live++;

    // typewriter prefixes (kerning-aware: measured, not summed)
    const prefix = new Float32Array(text.length + 1);
    for (let i = 1; i <= text.length; i++) prefix[i] = ctx.measureText(text.slice(0, i)).width;

    const s = this.surface(cw, ch);
    const c = s.ctx;
    c.save();
    c.globalCompositeOperation = "source-over";
    c.fillStyle = "#000";
    c.fillRect(0, 0, cw, ch);
    c.globalCompositeOperation = "lighter";
    c.font = fontCss;
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.lineJoin = "round";
    c.miterLimit = 2;
    if ("fontKerning" in c) c.fontKerning = "normal";
    if ("textRendering" in c) c.textRendering = "geometricPrecision";
    const x = pad;
    const y = pad + asc;
    c.fillStyle = "#ff0000";
    c.fillText(text, x, y);
    if (outlinePx > 0) {
      c.strokeStyle = "#00ff00";
      c.lineWidth = outlinePx * 2;
      c.strokeText(text, x, y);
    }
    if (blur > 0) {
      c.shadowColor = "#0000ff";
      c.shadowBlur = blur;
      c.fillStyle = "#0000ff";
      c.fillText(text, x, y);
    }
    c.restore();

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, page.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
    return { page: at.page, x: at.x, y: at.y, w: cw, h: ch, ox: pad, gw, baseline: y, rs, px, prefix };
  }

  /** A scratch surface of exactly w×h (the canvas is the upload source). */
  private surface(w: number, h: number): Surface {
    if (!this.scratch) this.scratch = createSurface(w, h);
    const s = this.scratch;
    if (s.canvas.width !== w) s.canvas.width = w;
    if (s.canvas.height !== h) s.canvas.height = h;
    return s;
  }

  dispose(): void {
    for (const p of this.pages) this.gl.deleteTexture(p.tex);
    this.pages.length = 0;
    this.entries.clear();
  }
}
