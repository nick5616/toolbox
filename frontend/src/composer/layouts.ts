import type { ComposerLayer, Composition } from "@/lib/api";
import { makeRng, type Rng } from "./rng";
import type { Sizer } from "./hittest";

// One-click layouts (SPEC.md Part B §B5.3). A layout positions the chosen
// image layers (or all visible, unlocked ones) and keeps the background and
// every other layer. It is a pure function of (document, kind, seed): the same
// seed gives the same result, "Shuffle" passes a new seed.

export type LayoutKind = "scatter" | "grid" | "stack" | "polaroids";

export const LAYOUTS: ReadonlyArray<{ id: LayoutKind; label: string; hint: string }> = [
  { id: "scatter", label: "Scatter", hint: "Cut-outs around a free middle" },
  { id: "grid", label: "Grid", hint: "Equal tiles with rounded corners" },
  { id: "stack", label: "Stack", hint: "Overlapping cards" },
  { id: "polaroids", label: "Polaroids", hint: "White frames, room for a caption" },
];

type Patch = Partial<ComposerLayer>;

const STICKER_OUTLINE = { on: true, width: 0.012, color: "#ffffff" };
const SOFT_SHADOW = { on: true, blur: 0.018, offsetX: 0, offsetY: 0.008, opacity: 0.35, color: "#000000" };
const NO_OUTLINE = { on: false, width: 0.012, color: "#ffffff" };
const NO_SHADOW = { on: false, blur: 0.02, offsetX: 0, offsetY: 0.008, opacity: 0.35, color: "#000000" };

interface Geometry {
  W: number;
  H: number;
}

/** Width/height of a layer's picture (its crop applied); 1 when unknown. */
function aspectOf(layer: ComposerLayer, sizer?: Sizer): number {
  if (!sizer) return 1;
  const s = sizer(layer);
  return s.w > 0 && s.h > 0 ? s.w / s.h : 1;
}

/**
 * Positions a w-wide picture of the given aspect at (cx, cy), rotated by rot
 * degrees, shrinking it until its rotated box (plus pad on every side) fits
 * the canvas and moving the centre so the box lies inside.
 */
function place(g: Geometry, cx: number, cy: number, w: number, aspect: number, rot: number, pad = 0): Patch {
  const rad = (Math.abs(rot) * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const extent = (width: number): [number, number] => {
    const h = width / aspect;
    return [width * c + h * s + 2 * pad, width * s + h * c + 2 * pad];
  };
  let [bw, bh] = extent(w);
  const f = Math.min(1, g.W / bw, g.H / bh);
  if (f < 1) {
    w *= f;
    [bw, bh] = extent(w);
  }
  const x = Math.min(g.W - bw / 2, Math.max(bw / 2, cx));
  const y = Math.min(g.H - bh / 2, Math.max(bh / 2, cy));
  return { x: x / g.W, y: y / g.H, size: w / g.W, rotation: rot };
}

/** Crop (within the layer's current crop) that makes the picture's aspect ratio target. */
function recrop(layer: ComposerLayer, current: number, target: number): NonNullable<ComposerLayer["image"]>["crop"] {
  const c = layer.image?.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  if (Math.abs(current - target) < 1e-6) return { ...c };
  if (current > target) {
    const w = (c.w * target) / current;
    return { x: c.x + (c.w - w) / 2, y: c.y, w, h: c.h };
  }
  const h = (c.h * current) / target;
  return { x: c.x, y: c.y + (c.h - h) / 2, w: c.w, h };
}

function withImage(layer: ComposerLayer, patch: Patch, crop?: NonNullable<ComposerLayer["image"]>["crop"], radius?: number): Patch {
  if (!layer.image) return patch;
  return { ...patch, image: { ...layer.image, crop: crop ?? layer.image.crop, radius: radius ?? layer.image.radius } };
}

function scatter(g: Geometry, items: ComposerLayer[], r: Rng, sizer?: Sizer): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const n = items.length;
  const order = r.shuffle(items);
  if (n === 1) {
    const l = order[0] as ComposerLayer;
    const a = aspectOf(l, sizer);
    const rot = r.range(-8, 8);
    out.set(l.id, { ...place(g, g.W / 2, g.H / 2, Math.min(0.7 * g.W, 0.7 * g.H * a), a, rot, 0.012 * g.W), outline: STICKER_OUTLINE, shadow: SOFT_SHADOW });
    return out;
  }
  const sides: ComposerLayer[][] = [[], []];
  order.forEach((l, i) => (sides[i % 2] as ComposerLayer[]).push(l));
  const baseW = Math.min(0.4 * g.W, Math.max(0.2 * g.W, (0.52 - 0.03 * n) * g.W));
  sides.forEach((list, side) => {
    const k = list.length;
    if (k === 0) return;
    const slotH = (0.8 * g.H) / k;
    list.forEach((l, j) => {
      const a = aspectOf(l, sizer);
      const w = Math.min(baseW, a * slotH * 1.15);
      const cx = (side === 0 ? 0.26 : 0.74) * g.W + r.range(-0.05, 0.05) * g.W;
      const cy = 0.1 * g.H + slotH * (j + 0.5) + r.range(-0.03, 0.03) * g.H;
      out.set(l.id, { ...place(g, cx, cy, w, a, r.range(-12, 12), 0.012 * g.W), outline: STICKER_OUTLINE, shadow: SOFT_SHADOW });
    });
  });
  return out;
}

/** Columns × rows for n tiles (2×2 up to 4×5). */
export function gridShape(n: number, portrait: boolean): [number, number] {
  if (n <= 1) return [1, 1];
  if (n === 2) return portrait ? [1, 2] : [2, 1];
  if (n <= 4) return [2, 2];
  if (n <= 6) return portrait ? [2, 3] : [3, 2];
  if (n <= 9) return [3, 3];
  if (n <= 12) return portrait ? [3, 4] : [4, 3];
  if (n <= 16) return [4, 4];
  if (n <= 20) return portrait ? [4, 5] : [5, 4];
  const cols = Math.ceil(Math.sqrt(n * (portrait ? 0.8 : 1.25)));
  return [cols, Math.ceil(n / cols)];
}

function grid(g: Geometry, items: ComposerLayer[], r: Rng, sizer?: Sizer): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const n = items.length;
  const order = r.shuffle(items);
  const [cols, rows] = gridShape(n, g.H >= g.W);
  const margin = 0.04 * g.W;
  const gutter = 0.02 * g.W;
  const cw = (g.W - 2 * margin - (cols - 1) * gutter) / cols;
  const ch = (g.H - 2 * margin - (rows - 1) * gutter) / rows;
  order.forEach((l, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * cw + (inRow - 1) * gutter;
    const cx = (g.W - rowW) / 2 + col * (cw + gutter) + cw / 2;
    const cy = margin + (g.H - 2 * margin - (rows * ch + (rows - 1) * gutter)) / 2 + row * (ch + gutter) + ch / 2;
    const a = aspectOf(l, sizer);
    const crop = recrop(l, a, cw / ch);
    out.set(
      l.id,
      withImage(l, { x: cx / g.W, y: cy / g.H, size: cw / g.W, rotation: 0, outline: NO_OUTLINE, shadow: NO_SHADOW }, crop, 0.06),
    );
  });
  return out;
}

function stack(g: Geometry, items: ComposerLayer[], r: Rng, sizer?: Sizer): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const n = items.length;
  const step = n > 1 ? Math.min(0.07 * g.H, (0.4 * g.H) / (n - 1)) : 0;
  items.forEach((l, i) => {
    const a = aspectOf(l, sizer);
    const w = Math.min(0.62 * g.W, 0.62 * g.H * a);
    const cx = 0.5 * g.W + r.range(-0.04, 0.04) * g.W;
    const cy = 0.5 * g.H + (i - (n - 1) / 2) * step;
    out.set(l.id, {
      ...withImage(l, place(g, cx, cy, w, a, r.range(-8, 8), 0.01 * g.W), undefined, 0.02),
      outline: { on: true, width: 0.01, color: "#ffffff" },
      shadow: { on: true, blur: 0.03, offsetX: 0, offsetY: 0.012, opacity: 0.4, color: "#000000" },
    });
  });
  return out;
}

function polaroids(g: Geometry, items: ComposerLayer[], r: Rng, sizer?: Sizer): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const n = items.length;
  const order = r.shuffle(items);
  const [cols, rows] = gridShape(n, g.H >= g.W);
  const frame = 0.03;
  // Cards use the top 84 % of the canvas; the strip below is left free for a caption.
  const top = 0.03 * g.H;
  const areaW = 0.94 * g.W;
  const areaH = 0.81 * g.H;
  const cw = areaW / cols;
  const ch = areaH / rows;
  order.forEach((l, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, n - row * cols);
    const cx = 0.03 * g.W + (areaW - inRow * cw) / 2 + col * cw + cw / 2;
    const cy = top + row * ch + ch / 2;
    const side = Math.min(cw, ch) * 0.86 - 2 * frame * g.W;
    const a = aspectOf(l, sizer);
    out.set(l.id, {
      ...withImage(l, place(g, cx, cy, Math.max(0.05 * g.W, side), 1, r.range(-6, 6), frame * g.W), recrop(l, a, 1), 0),
      outline: { on: true, width: frame, color: "#ffffff" },
      shadow: SOFT_SHADOW,
    });
  });
  return out;
}

/**
 * Applies a layout to layerIds (the selected image layers) or, when absent
 * or empty, to every visible unlocked image layer. sizer gives each layer's
 * picture aspect (render.layerSize); without it pictures are treated as square.
 * Returns doc itself when there is nothing to lay out.
 */
export function applyLayout(doc: Composition, kind: LayoutKind, seed: number, layerIds?: readonly string[], sizer?: Sizer): Composition {
  const wanted = layerIds && layerIds.length > 0 ? new Set(layerIds) : null;
  const layers = doc.layers ?? [];
  const items = layers.filter((l) => l.kind === "image" && l.image && !l.hidden && !l.locked && (!wanted || wanted.has(l.id)));
  if (items.length === 0) return doc;
  const g: Geometry = { W: doc.width, H: doc.height };
  const r = makeRng(seed);
  const patches = { scatter, grid, stack, polaroids }[kind](g, items, r, sizer);
  return { ...doc, layers: layers.map((l) => (patches.has(l.id) ? { ...l, ...patches.get(l.id) } : l)) };
}
