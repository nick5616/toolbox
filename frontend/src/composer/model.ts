import type { Composition, ComposerLayer, ComposerLook } from "@/lib/api";

// Defaults, factories, sanitising and layer operations for the Photo
// Composer's document (SPEC.md Part B §B5.1). Pure functions: every edit
// returns a new document and shares what didn't change.

export const MAX_LAYERS = 60;
export const MAX_TEXT_CHARS = 500;

/** media.Fonts() on the Go side. */
export const COMPOSER_FONTS = ["Arial", "Verdana", "Georgia", "Trebuchet MS", "Impact", "Courier New"] as const;

export interface AspectSize {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** Mirrors composer.Aspects() (the Go side is the source of truth). */
export const ASPECTS: readonly AspectSize[] = [
  { id: "4:5", label: "Portrait 4:5", width: 1080, height: 1350 },
  { id: "1:1", label: "Square 1:1", width: 1080, height: 1080 },
  { id: "3:4", label: "Tall 3:4", width: 1080, height: 1440 },
  { id: "1.91:1", label: "Landscape 1.91:1", width: 1080, height: 566 },
  { id: "9:16", label: "Story 9:16", width: 1080, height: 1920 },
  { id: "16:9", label: "Wide 16:9", width: 1920, height: 1080 },
];

export function aspectSize(id: string): AspectSize {
  return ASPECTS.find((a) => a.id === id) ?? (ASPECTS[0] as AspectSize);
}

export const NO_LOOK: ComposerLook = { preset: "none", brightness: 0, contrast: 0, saturation: 0, warmth: 0 };

export function defaultShadow(): ComposerLayer["shadow"] {
  return { on: false, blur: 0.02, offsetX: 0, offsetY: 0.008, opacity: 0.35, color: "#000000" };
}

export function defaultOutline(): ComposerLayer["outline"] {
  return { on: false, width: 0.012, color: "#ffffff" };
}

/** A blank composition at the aspect with a white background. */
export function newComposition(aspect = "4:5"): Composition {
  const a = aspectSize(aspect);
  return {
    version: 1,
    width: a.width,
    height: a.height,
    aspect: a.id,
    background: {
      kind: "color", color: "#ffffff", color2: "#000000", angle: 180, image: null,
      panX: 0, panY: 0, zoom: 1, blur: 0, look: { ...NO_LOOK },
    },
    layers: [],
    format: "jpg",
  };
}

let idCounter = 0;
/** A layer ID that is unique within a session and across reloads. */
export function newLayerId(): string {
  idCounter++;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36);
  return `l${idCounter}-${rand}`;
}

function baseName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** An image layer centred on the canvas, fitted inside 60 % of it. */
export function newImageLayer(path: string, natW: number, natH: number, doc: Pick<Composition, "width" | "height">): ComposerLayer {
  const nw = natW > 0 ? natW : 1;
  const nh = natH > 0 ? natH : 1;
  const w = Math.min(0.6 * doc.width, (0.6 * doc.height * nw) / nh);
  return {
    id: newLayerId(), kind: "image", name: baseName(path) || "Photo", hidden: false, locked: false,
    x: 0.5, y: 0.5, size: w / doc.width, rotation: 0, flipX: false, opacity: 1,
    image: { ref: { path, original: "" }, crop: { x: 0, y: 0, w: 1, h: 1 }, radius: 0 },
    text: null, shadow: defaultShadow(), outline: defaultOutline(), look: { ...NO_LOOK },
  };
}

export function newTextLayer(doc: Pick<Composition, "width" | "height">): ComposerLayer {
  void doc;
  return {
    id: newLayerId(), kind: "text", name: "Text", hidden: false, locked: false,
    x: 0.5, y: 0.5, size: 0.08, rotation: 0, flipX: false, opacity: 1,
    image: null,
    text: { text: "Text", font: "Arial", bold: true, italic: false, color: "#111111", align: "center", lineHeight: 1.2, pill: "" },
    shadow: defaultShadow(), outline: defaultOutline(), look: { ...NO_LOOK },
  };
}

// --- sanitising (never throws) ----------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, def: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
const str = (v: unknown, def: string): string => (typeof v === "string" ? v : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
const hex = (v: unknown, def: string): string => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : def);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;

function cleanLook(v: unknown): ComposerLook {
  const r = isRec(v) ? v : {};
  return {
    preset: oneOf(r.preset, ["none", "vivid", "warm", "cool", "mono", "fade", "noir"] as const, "none"),
    brightness: num(r.brightness, 0, -1, 1),
    contrast: num(r.contrast, 0, -1, 1),
    saturation: num(r.saturation, 0, -1, 1),
    warmth: num(r.warmth, 0, -1, 1),
  };
}

function cleanRef(v: unknown): { path: string; original: string } | null {
  if (!isRec(v)) return null;
  const path = str(v.path, "");
  return path ? { path, original: str(v.original, "") } : null;
}

function cleanLayer(v: unknown): ComposerLayer | null {
  if (!isRec(v)) return null;
  const kind = oneOf(v.kind, ["image", "text"] as const, "image");
  const sh = isRec(v.shadow) ? v.shadow : {};
  const ol = isRec(v.outline) ? v.outline : {};
  const base = {
    id: str(v.id, ""), kind, name: str(v.name, kind === "text" ? "Text" : "Photo").slice(0, 120),
    hidden: bool(v.hidden, false), locked: bool(v.locked, false),
    x: num(v.x, 0.5, -2, 3), y: num(v.y, 0.5, -2, 3),
    size: num(v.size, kind === "text" ? 0.08 : 0.4, 0.005, kind === "text" ? 1 : 5),
    rotation: num(v.rotation, 0, -3600, 3600), flipX: bool(v.flipX, false), opacity: num(v.opacity, 1, 0, 1),
    shadow: {
      on: bool(sh.on, false), blur: num(sh.blur, 0.02, 0, 0.5), offsetX: num(sh.offsetX, 0, -0.5, 0.5),
      offsetY: num(sh.offsetY, 0.008, -0.5, 0.5), opacity: num(sh.opacity, 0.35, 0, 1), color: hex(sh.color, "#000000"),
    },
    outline: { on: bool(ol.on, false), width: num(ol.width, 0.012, 0, 0.2), color: hex(ol.color, "#ffffff") },
    look: cleanLook(v.look),
  };
  if (kind === "image") {
    const im = isRec(v.image) ? v.image : null;
    const ref = im ? cleanRef(im.ref) : null;
    if (!im || !ref) return null;
    const c = isRec(im.crop) ? im.crop : {};
    const cx = num(c.x, 0, 0, 1);
    const cy = num(c.y, 0, 0, 1);
    const cw = Math.min(num(c.w, 1, 0.001, 1), 1 - cx);
    const ch = Math.min(num(c.h, 1, 0.001, 1), 1 - cy);
    return { ...base, image: { ref, crop: { x: cx, y: cy, w: Math.max(cw, 0.001), h: Math.max(ch, 0.001) }, radius: num(im.radius, 0, 0, 0.5) }, text: null };
  }
  const t = isRec(v.text) ? v.text : null;
  if (!t) return null;
  const font = str(t.font, "Arial");
  const pill = typeof t.pill === "string" && /^#[0-9a-fA-F]{6}$/.test(t.pill) ? t.pill : "";
  return {
    ...base, image: null,
    text: {
      text: Array.from(str(t.text, "")).slice(0, MAX_TEXT_CHARS).join(""),
      font: (COMPOSER_FONTS as readonly string[]).includes(font) ? font : "Arial",
      bold: bool(t.bold, false), italic: bool(t.italic, false), color: hex(t.color, "#111111"),
      align: oneOf(t.align, ["left", "center", "right"] as const, "center"),
      lineHeight: num(t.lineHeight, 1.2, 0.8, 2), pill,
    },
  };
}

/**
 * Turns anything into a valid Composition (what Go would accept). Unknown or
 * broken parts fall back to defaults; broken layers are dropped; duplicate
 * layer IDs are renamed. Never throws.
 */
export function sanitizeComposition(input: unknown): Composition {
  try {
    const r = isRec(input) ? input : {};
    const a = aspectSize(typeof r.aspect === "string" ? r.aspect : "4:5");
    const def = newComposition(a.id);
    const b = isRec(r.background) ? r.background : {};
    const kind = oneOf(b.kind, ["color", "gradient", "image"] as const, "color");
    const image = cleanRef(b.image);
    const layers: ComposerLayer[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(r.layers) ? r.layers : []) {
      if (layers.length >= MAX_LAYERS) break;
      const l = cleanLayer(raw);
      if (!l) continue;
      if (!l.id || seen.has(l.id)) l.id = newLayerId();
      seen.add(l.id);
      layers.push(l);
    }
    return {
      version: 1, width: a.width, height: a.height, aspect: a.id,
      background: {
        kind: kind === "image" && !image ? "color" : kind,
        color: hex(b.color, def.background.color), color2: hex(b.color2, def.background.color2),
        angle: Math.round(num(b.angle, def.background.angle, -360, 360)), image,
        panX: num(b.panX, 0, -1, 1), panY: num(b.panY, 0, -1, 1), zoom: num(b.zoom, 1, 1, 4), blur: num(b.blur, 0, 0, 1),
        look: cleanLook(b.look),
      },
      layers,
      format: oneOf(r.format, ["jpg", "png"] as const, "jpg"),
    };
  } catch {
    return newComposition("4:5");
  }
}

// --- layer operations -----------------------------------------------------

export type MoveDirection = "up" | "down" | "top" | "bottom";

export function findLayer(doc: Composition, id: string): ComposerLayer | undefined {
  return (doc.layers ?? []).find((l) => l.id === id);
}

export function layerList(doc: Composition): ComposerLayer[] {
  return doc.layers ?? [];
}

export function addLayer(doc: Composition, layer: ComposerLayer): Composition {
  const layers = layerList(doc);
  if (layers.length >= MAX_LAYERS) return doc;
  return { ...doc, layers: [...layers, layer] };
}

/** Replaces one layer with patch applied (shallow). */
export function updateLayer(doc: Composition, id: string, patch: Partial<ComposerLayer>): Composition {
  let changed = false;
  const layers = layerList(doc).map((l) => {
    if (l.id !== id) return l;
    changed = true;
    return { ...l, ...patch };
  });
  return changed ? { ...doc, layers } : doc;
}

export function moveLayer(doc: Composition, id: string, dir: MoveDirection): Composition {
  const layers = layerList(doc).slice();
  const from = layers.findIndex((l) => l.id === id);
  if (from < 0) return doc;
  const to = dir === "up" ? from + 1 : dir === "down" ? from - 1 : dir === "top" ? layers.length - 1 : 0;
  if (to < 0 || to >= layers.length || to === from) return doc;
  const [l] = layers.splice(from, 1);
  layers.splice(to, 0, l as ComposerLayer);
  return { ...doc, layers };
}

/** Moves a layer to index (bottom = 0), for drag-to-reorder. */
export function reorderLayer(doc: Composition, id: string, index: number): Composition {
  const layers = layerList(doc).slice();
  const from = layers.findIndex((l) => l.id === id);
  if (from < 0) return doc;
  const to = Math.max(0, Math.min(layers.length - 1, index));
  if (to === from) return doc;
  const [l] = layers.splice(from, 1);
  layers.splice(to, 0, l as ComposerLayer);
  return { ...doc, layers };
}

/** Copies a layer just above itself, nudged so it's visible. */
export function duplicateLayer(doc: Composition, id: string): { doc: Composition; id: string | null } {
  const layers = layerList(doc);
  const i = layers.findIndex((l) => l.id === id);
  const src = layers[i];
  if (!src || layers.length >= MAX_LAYERS) return { doc, id: null };
  const copy: ComposerLayer = {
    ...structuredCloneLayer(src), id: newLayerId(), name: `${src.name} copy`.slice(0, 120), locked: false,
    x: src.x + 0.03, y: src.y + 0.03,
  };
  const next = layers.slice();
  next.splice(i + 1, 0, copy);
  return { doc: { ...doc, layers: next }, id: copy.id };
}

function structuredCloneLayer(l: ComposerLayer): ComposerLayer {
  return JSON.parse(JSON.stringify(l)) as ComposerLayer;
}

export function deleteLayer(doc: Composition, id: string): Composition {
  const layers = layerList(doc);
  if (!layers.some((l) => l.id === id)) return doc;
  return { ...doc, layers: layers.filter((l) => l.id !== id) };
}

/** Swaps a cut-out in (or the original back); keeps both paths. */
export function setLayerSource(doc: Composition, id: string, path: string, original: string): Composition {
  const l = findLayer(doc, id);
  if (!l?.image) return doc;
  return updateLayer(doc, id, { image: { ...l.image, ref: { path, original } } });
}
