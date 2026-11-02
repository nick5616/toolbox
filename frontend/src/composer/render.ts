import type { ComposerLayer, ComposerLook, Composition } from "@/lib/api";
import { applyLook, isIdentityLook } from "./looks";

// The Photo Composer's renderer (SPEC.md Part B §B5.2). The editor and the
// export both draw with renderComposition, so what you see is what's saved.
//
// Per-layer work (crop, rounded clip, look, outline, text layout) is rendered
// into an offscreen "sprite" that is cached by the layer's content and the
// scale; moving, rotating, fading or re-shadowing a layer only redraws that
// sprite, so dragging stays fast. The shadow is drawn with the 2D context's
// own shadow properties (offsets are in canvas space, unaffected by rotation).
// No Math.random, Date or ctx.filter: the same inputs give the same pixels.

/** Any 2D context the renderer can draw on (on-screen or offscreen). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Decoded source images by path (from ComposerService.LoadImage). */
export type ImageMap = ReadonlyMap<string, ImageBitmap | HTMLImageElement>;

export interface RenderOptions {
  /** Output pixels per document pixel (1 = Width×Height). */
  scale: number;
  /** Draw editor-only hints (none yet; selection is drawn by the stage, not here). */
  editor?: boolean;
}

// --- offscreen canvases --------------------------------------------------------

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
export type CanvasFactory = (width: number, height: number) => CanvasLike;

const defaultFactory: CanvasFactory = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

let factory: CanvasFactory = defaultFactory;
let measureCtx: Ctx2D | null | undefined;

/** Replaces how offscreen canvases are made (tests); null restores the default. */
export function setCanvasFactory(f: CanvasFactory | null): void {
  factory = f ?? defaultFactory;
  measureCtx = undefined;
  clearRenderCache();
}

function makeCanvas(w: number, h: number): CanvasLike {
  return factory(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

function ctxOf(c: CanvasLike): Ctx2D {
  const ctx = (c as { getContext(id: "2d"): Ctx2D | null }).getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  return ctx;
}

/** Largest sprite side in pixels; bigger layers are rendered smaller and scaled up. */
const MAX_SPRITE = 4096;
/** Cached sprite pixels (about 200 MB). */
const CACHE_PIXELS = 50_000_000;
const CACHE_ENTRIES = 48;

interface Sprite {
  canvas: CanvasLike;
  /** Content size in output pixels (without margin). */
  w: number;
  h: number;
  /** Extra border for outline/stroke, in output pixels. */
  margin: number;
  px: number;
}

const spriteCache = new Map<string, Sprite>();
let spritePixels = 0;

export function clearRenderCache(): void {
  spriteCache.clear();
  spritePixels = 0;
}

function cached(key: string, build: () => Sprite): Sprite {
  const hit = spriteCache.get(key);
  if (hit) {
    spriteCache.delete(key);
    spriteCache.set(key, hit);
    return hit;
  }
  const s = build();
  spriteCache.set(key, s);
  spritePixels += s.px;
  for (const [k, v] of spriteCache) {
    if (spriteCache.size <= CACHE_ENTRIES && spritePixels <= CACHE_PIXELS) break;
    if (k === key) continue;
    spriteCache.delete(k);
    spritePixels -= v.px;
  }
  return s;
}

const bitmapIds = new WeakMap<object, number>();
let nextBitmapId = 1;
function bitmapId(img: object): number {
  let id = bitmapIds.get(img);
  if (id === undefined) {
    id = nextBitmapId++;
    bitmapIds.set(img, id);
  }
  return id;
}

export function imageSize(img: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  if ("naturalWidth" in img && img.naturalWidth > 0) return { w: img.naturalWidth, h: img.naturalHeight };
  return { w: img.width, h: img.height };
}

// --- helpers ------------------------------------------------------------------

function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const n = m ? parseInt(m[1] as string, 16) : 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.min(1, Math.max(0, alpha))})`;
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function applyLookToCanvas(ctx: Ctx2D, w: number, h: number, look: ComposerLook): void {
  if (isIdentityLook(look)) return;
  const data = ctx.getImageData(0, 0, w, h);
  applyLook(data.data, look);
  ctx.putImageData(data, 0, 0);
}

/** Halves the canvas until the blur radius is reached, then doubles back up. */
function blurCanvas(src: CanvasLike, w: number, h: number, radius: number): CanvasLike {
  let steps = 0;
  while (2 ** (steps + 1) <= radius && steps < 8) steps++;
  if (steps === 0) return src;
  const sizes: Array<[number, number]> = [[w, h]];
  let cur = src;
  for (let i = 0; i < steps; i++) {
    const [pw, ph] = sizes[sizes.length - 1] as [number, number];
    const nw = Math.max(1, Math.ceil(pw / 2));
    const nh = Math.max(1, Math.ceil(ph / 2));
    const c = makeCanvas(nw, nh);
    const cx = ctxOf(c);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(cur as CanvasImageSource, 0, 0, nw, nh);
    sizes.push([nw, nh]);
    cur = c;
  }
  for (let i = steps - 1; i >= 0; i--) {
    const [nw, nh] = sizes[i] as [number, number];
    const c = makeCanvas(nw, nh);
    const cx = ctxOf(c);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(cur as CanvasImageSource, 0, 0, nw, nh);
    cur = c;
  }
  return cur;
}

// --- background -----------------------------------------------------------------

/** Draws the background onto ctx (doc.width×scale by doc.height×scale). */
export function renderBackground(ctx: Ctx2D, doc: Composition, images: ImageMap, scale: number): void {
  const W = doc.width * scale;
  const H = doc.height * scale;
  const b = doc.background;
  ctx.save();
  ctx.fillStyle = b.color || "#ffffff";
  ctx.fillRect(0, 0, W, H);
  if (b.kind === "gradient") {
    const a = ((b.angle || 0) * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const len = Math.abs(W * dx) + Math.abs(H * dy);
    const g = ctx.createLinearGradient(W / 2 - (dx * len) / 2, H / 2 - (dy * len) / 2, W / 2 + (dx * len) / 2, H / 2 + (dy * len) / 2);
    g.addColorStop(0, b.color || "#ffffff");
    g.addColorStop(1, b.color2 || "#000000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (b.kind === "image" && b.image?.path) {
    const img = images.get(b.image.path);
    if (img) drawBackgroundImage(ctx, doc, img, W, H, scale);
  }
  ctx.restore();
}

function drawBackgroundImage(ctx: Ctx2D, doc: Composition, img: ImageBitmap | HTMLImageElement, W: number, H: number, scale: number): void {
  const b = doc.background;
  const { w: iw, h: ih } = imageSize(img);
  if (iw <= 0 || ih <= 0) return;
  const k = Math.max(W / iw, H / ih) * Math.max(1, b.zoom || 1);
  const dw = iw * k;
  const dh = ih * k;
  // pan +1 shows the image's right/bottom edge, -1 the left/top edge.
  const dx = (W - dw) / 2 - (b.panX || 0) * ((dw - W) / 2);
  const dy = (H - dh) / 2 - (b.panY || 0) * ((dh - H) / 2);
  const radius = (b.blur || 0) * 40 * (doc.width / 1080) * scale;
  const needsLook = !isIdentityLook(b.look);
  if (radius < 1.5 && !needsLook) {
    ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
    return;
  }
  const off = makeCanvas(W, H);
  const octx = ctxOf(off);
  octx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
  const blurred = radius >= 1.5 ? blurCanvas(off, Math.round(W), Math.round(H), radius) : off;
  if (needsLook) {
    const lctx = ctxOf(blurred);
    applyLookToCanvas(lctx, Math.round(W), Math.round(H), b.look);
  }
  ctx.drawImage(blurred as CanvasImageSource, 0, 0, W, H);
}

// --- text ---------------------------------------------------------------------

export interface TextLayout {
  lines: string[];
  font: string;
  fontPx: number;
  lineH: number;
  blockW: number;
  blockH: number;
  padX: number;
  padY: number;
  /** Whole layer box (text block plus pill padding). */
  boxW: number;
  boxH: number;
}

function measurer(): Ctx2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = ctxOf(makeCanvas(1, 1));
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx;
}

export function textFont(layer: ComposerLayer, fontPx: number): string {
  const t = layer.text;
  return `${t?.italic ? "italic " : ""}${t?.bold ? "700" : "400"} ${fontPx}px "${t?.font || "Arial"}", sans-serif`;
}

/** Lays out a text layer's lines (wrapping at newlines only) at scale. */
export function textLayout(layer: ComposerLayer, docWidth: number, scale: number): TextLayout {
  const t = layer.text;
  const fontPx = Math.max(1, layer.size * docWidth * scale);
  const lines = (t?.text ?? "").split("\n");
  const font = textFont(layer, fontPx);
  const m = measurer();
  let blockW = 0;
  if (m) {
    m.save();
    m.font = font;
    for (const line of lines) blockW = Math.max(blockW, m.measureText(line).width);
    m.restore();
  } else {
    for (const line of lines) blockW = Math.max(blockW, Array.from(line).length * fontPx * 0.55);
  }
  const lineH = fontPx * (t?.lineHeight || 1.2);
  const blockH = lineH * lines.length;
  const pill = !!t?.pill;
  const padX = pill ? fontPx * 0.4 : 0;
  const padY = pill ? fontPx * 0.18 : 0;
  return { lines, font, fontPx, lineH, blockW, blockH, padX, padY, boxW: blockW + 2 * padX, boxH: blockH + 2 * padY };
}

/** A layer's size in document pixels before rotation (scale 1). */
export function layerSize(doc: Composition, layer: ComposerLayer, images: ImageMap): { w: number; h: number } {
  if (layer.kind === "text") {
    const t = textLayout(layer, doc.width, 1);
    return { w: Math.max(1, t.boxW), h: Math.max(1, t.boxH) };
  }
  const w = layer.size * doc.width;
  const im = layer.image;
  const img = im ? images.get(im.ref.path) : undefined;
  if (!im || !img) return { w, h: w };
  const { w: bw, h: bh } = imageSize(img);
  const cw = Math.max(1e-6, im.crop.w * bw);
  const ch = Math.max(1e-6, im.crop.h * bh);
  return { w, h: (w * ch) / cw };
}

function outlinePx(doc: Composition, layer: ComposerLayer, scale: number): number {
  return layer.outline.on ? Math.max(0, layer.outline.width * doc.width * scale) : 0;
}

function buildTextSprite(doc: Composition, layer: ComposerLayer, scale: number): Sprite {
  const t = layer.text as NonNullable<ComposerLayer["text"]>;
  const lay = textLayout(layer, doc.width, scale);
  const stroke = outlinePx(doc, layer, scale);
  const margin = stroke > 0 ? Math.ceil(stroke) + 1 : 0;
  const fullW = lay.boxW + 2 * margin;
  const fullH = lay.boxH + 2 * margin;
  const k = Math.min(1, MAX_SPRITE / Math.max(fullW, fullH));
  const canvas = makeCanvas(fullW * k, fullH * k);
  const c = ctxOf(canvas);
  c.scale(k, k);
  c.translate(margin + lay.boxW / 2, margin + lay.boxH / 2);
  if (t.pill) {
    c.fillStyle = t.pill;
    roundRectPath(c, -lay.boxW / 2, -lay.boxH / 2, lay.boxW, lay.boxH, Math.min(lay.boxH / 2, lay.fontPx * 0.45));
    c.fill();
  }
  c.font = lay.font;
  c.textBaseline = "middle";
  c.textAlign = t.align === "left" ? "left" : t.align === "right" ? "right" : "center";
  const tx = t.align === "left" ? -lay.blockW / 2 : t.align === "right" ? lay.blockW / 2 : 0;
  const top = -lay.blockH / 2;
  lay.lines.forEach((line, i) => {
    const y = top + (i + 0.5) * lay.lineH;
    if (stroke > 0) {
      c.lineJoin = "round";
      c.lineWidth = stroke * 2;
      c.strokeStyle = layer.outline.color;
      c.strokeText(line, tx, y);
    }
    c.fillStyle = t.color;
    c.fillText(line, tx, y);
  });
  return { canvas, w: lay.boxW, h: lay.boxH, margin, px: Math.round(fullW * k) * Math.round(fullH * k) };
}

// --- image layers -----------------------------------------------------------------

function buildImageSprite(doc: Composition, layer: ComposerLayer, img: ImageBitmap | HTMLImageElement, scale: number): Sprite {
  const im = layer.image as NonNullable<ComposerLayer["image"]>;
  const { w: bw, h: bh } = imageSize(img);
  const sx = im.crop.x * bw;
  const sy = im.crop.y * bh;
  const sw = Math.max(1, im.crop.w * bw);
  const sh = Math.max(1, im.crop.h * bh);
  const w = layer.size * doc.width * scale;
  const h = (w * sh) / sw;
  const stroke = outlinePx(doc, layer, scale);
  const margin = stroke > 0 ? Math.ceil(stroke) + 1 : 0;
  const k = Math.min(1, MAX_SPRITE / Math.max(w + 2 * margin, h + 2 * margin));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const m = margin * k;

  // 1. crop + rounded clip
  const content = makeCanvas(cw, ch);
  const cx = ctxOf(content);
  cx.save();
  if (im.radius > 0) {
    roundRectPath(cx, 0, 0, cw, ch, im.radius * Math.min(cw, ch));
    cx.clip();
  }
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = "high";
  cx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, 0, 0, cw, ch);
  cx.restore();
  // 2. look
  applyLookToCanvas(cx, cw, ch, layer.look);
  // 3. outline under the picture
  const full = makeCanvas(cw + 2 * m, ch + 2 * m);
  const fx = ctxOf(full);
  if (stroke > 0) {
    const mask = makeCanvas(cw, ch);
    const mx = ctxOf(mask);
    mx.drawImage(content as CanvasImageSource, 0, 0);
    mx.globalCompositeOperation = "source-in";
    mx.fillStyle = layer.outline.color;
    mx.fillRect(0, 0, cw, ch);
    const r = stroke * k;
    const rings = r > 12 ? [1, 0.66, 0.33] : r > 5 ? [1, 0.5] : [1];
    for (const ring of rings) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        fx.drawImage(mask as CanvasImageSource, m + Math.cos(a) * r * ring, m + Math.sin(a) * r * ring);
      }
    }
  }
  fx.drawImage(content as CanvasImageSource, m, m);
  return { canvas: full, w, h, margin, px: Math.round((cw + 2 * m) * (ch + 2 * m)) };
}

function spriteFor(doc: Composition, layer: ComposerLayer, images: ImageMap, scale: number): Sprite | null {
  const common = `${scale}|${doc.width}|${layer.size}|${JSON.stringify(layer.outline.on ? layer.outline : null)}`;
  if (layer.kind === "text") {
    if (!layer.text || layer.text.text === "") return null;
    const key = `t|${common}|${JSON.stringify(layer.text)}`;
    return cached(key, () => buildTextSprite(doc, layer, scale));
  }
  const im = layer.image;
  const img = im ? images.get(im.ref.path) : undefined;
  if (!im || !img) return null;
  const key = `i|${common}|${bitmapId(img)}|${JSON.stringify(im.crop)}|${im.radius}|${JSON.stringify(layer.look)}`;
  return cached(key, () => buildImageSprite(doc, layer, img, scale));
}

/** Draws one layer (hidden layers and layers whose image is missing draw nothing). */
export function renderLayer(ctx: Ctx2D, doc: Composition, layer: ComposerLayer, images: ImageMap, scale: number): void {
  if (layer.hidden || layer.opacity <= 0) return;
  const sprite = spriteFor(doc, layer, images, scale);
  if (!sprite) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, layer.opacity);
  ctx.translate(layer.x * doc.width * scale, layer.y * doc.height * scale);
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
  if (layer.flipX) ctx.scale(-1, 1);
  if (layer.shadow.on) {
    ctx.shadowColor = rgba(layer.shadow.color, layer.shadow.opacity);
    ctx.shadowBlur = layer.shadow.blur * doc.width * scale;
    ctx.shadowOffsetX = layer.shadow.offsetX * doc.width * scale;
    ctx.shadowOffsetY = layer.shadow.offsetY * doc.width * scale;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    sprite.canvas as CanvasImageSource,
    -(sprite.w / 2 + sprite.margin),
    -(sprite.h / 2 + sprite.margin),
    sprite.w + 2 * sprite.margin,
    sprite.h + 2 * sprite.margin,
  );
  ctx.restore();
}

/**
 * Draws doc onto ctx, whose canvas is doc.width×scale by doc.height×scale.
 * Missing images are skipped (drawn as nothing). Deterministic for the same
 * inputs and scale.
 */
export function renderComposition(ctx: Ctx2D, doc: Composition, images: ImageMap, opts: RenderOptions): void {
  ctx.save();
  renderBackground(ctx, doc, images, opts.scale);
  for (const layer of doc.layers ?? []) renderLayer(ctx, doc, layer, images, opts.scale);
  ctx.restore();
}

/** The source paths a document needs loaded (background + image layers). */
export function imagePaths(doc: Composition): string[] {
  const out = new Set<string>();
  if (doc.background.kind === "image" && doc.background.image?.path) out.add(doc.background.image.path);
  for (const l of doc.layers ?? []) if (l.kind === "image" && l.image?.ref.path) out.add(l.image.ref.path);
  return [...out];
}
