/**
 * The real modules behind the seam (engine-adapter.ts): P1's engine, B1's
 * bundled library, the engine's guides, P6's perception queue and operations,
 * and P1's adjustments. Active in the app (PaintView.tsx calls
 * `enableRealRuntime()` before the first painting opens); the vitest suites
 * and `npm run dev` without a GPU keep the fakes.
 */
import { PaintService } from "@/lib/api";
import { AdjustSession, LiquifyField, colorBalance, curves, gaussianBlur, gradientMap, hsb, motionBlur, noise, sharpen, type GradientStop } from "@/paint/adjust";
import {
  CancelledError,
  createObjectSelector,
  createPerceptionQueue,
  createStampTips,
  cutSubjectToNewLayer,
  extendCanvasWithFill,
  runEnhanceBrush,
  runFillTool,
  selectSubject,
  upscaleCanvas,
  warmOnce,
  type PerceptionQueueImpl,
  type StampTips,
} from "@/paint/ai";
import type { AssetImage, AssetResolver } from "@/paint/brushes/assets";
import { LIBRARY_PRESETS, SET_NAMES, resolveLibraryAsset } from "@/paint/brushes/library";
import type { BrushPreset } from "@/paint/brushes/schema";
import { createPaintEngine, type PaintEngineExt } from "@/paint/engine/engine";
import type { PaintEngine } from "@/paint/engine/types";
import { parseGuides, type GuidesConfig } from "@/paint/guides/guides";
import type { LabParam, LabParams, LabToolInfo } from "@/paint/lab/types";
import { setRuntime, type AdjustEffect, type AdjustHandle, type AdjustmentInfo, type GuidesState, type LiquifyHandle, type PaintRuntime } from "./engine-adapter";

async function toImage(url: string): Promise<AssetImage | null> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

/** The Subject stamp's cut-outs, shared with the resolver below ("stamp:<layerId>"). */
let activeTips: StampTips | null = null;

/** "lib:<file>" from the bundled library, "set:<id>/<file>" from a user or imported set, "stamp:<layer>" from Subject stamp. */
export const assetResolver: AssetResolver = async (ref) => {
  try {
    if (ref.startsWith("lib:")) return await toImage(resolveLibraryAsset(ref));
    if (ref.startsWith("set:")) {
      const [set, ...file] = ref.slice(4).split("/");
      return await toImage(await PaintService.BrushAsset(set ?? "", file.join("/")));
    }
    if (ref.startsWith("stamp:")) {
      const tip = activeTips?.tip(ref.slice(6));
      return tip ? { data: tip.image.data, width: tip.image.width, height: tip.image.height } : null;
    }
  } catch {
    /* a missing image paints with the round fallback */
  }
  return null;
};

const base = (ref: string) => ref.split("/").pop()?.replace(/\.png$/i, "").replace(/[-_]/g, " ") ?? ref;

function choices(kind: "tip" | "grain"): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const p of LIBRARY_PRESETS) {
    const ref = kind === "tip" ? p.tip.shape : p.grain.texture;
    if (ref.startsWith("lib:")) seen.set(ref, base(ref));
  }
  const own = kind === "tip" ? [{ value: "round", label: "Round" }, { value: "square", label: "Square" }] : [{ value: "", label: "None" }];
  return [...own, ...[...seen].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
}

/** The UI's guides model → the engine's. */
export function toEngineGuides(g: GuidesState, current: GuidesConfig, size: { w: number; h: number }): GuidesConfig {
  const mode = g.symmetry === "off" ? "off" : g.symmetry;
  return {
    ...current,
    symmetry: { ...current.symmetry, mode: mode as GuidesConfig["symmetry"]["mode"], count: g.radialCount, cx: current.symmetry.cx || size.w / 2, cy: current.symmetry.cy || size.h / 2 },
    grid: { ...current.grid, on: g.grid },
    perspective: { ...current.perspective, points: g.perspective, assist: g.perspective > 0 },
    iso: { ...current.iso, on: g.isometric, assist: g.isometric },
  };
}

type Ext = PaintEngine & PaintEngineExt;

// ---- Adjustments ----

const num = (id: string, label: string, min: number, max: number, def: number, tip: string, extra: Partial<Extract<LabParam, { type: "number" }>> = {}): LabParam => ({ id, label, type: "number", min, max, default: def, tip, ...extra });

function adj(id: string, label: string, icon: string, description: string, params: LabParam[], build: (v: LabParams) => AdjustEffect): AdjustmentInfo {
  const tool: LabToolInfo = { id: `adjust-${id}`, label, description, kind: "algorithmic", predictability: "exact", origin: { kind: "algorithm", text: "Plain pixel maths on the layer. Same settings, same result." }, params, icon };
  return { id, label, icon, available: true, tool, build };
}

const n = (v: LabParams, k: string): number => Number(v[k] ?? 0);

const GRADIENTS: Record<string, GradientStop[]> = {
  sepia: [
    { pos: 0, r: 0.1, g: 0.05, b: 0.02 },
    { pos: 1, r: 1, g: 0.92, b: 0.76 },
  ],
  cool: [
    { pos: 0, r: 0.02, g: 0.05, b: 0.2 },
    { pos: 0.55, r: 0.2, g: 0.5, b: 0.7 },
    { pos: 1, r: 0.95, g: 1, b: 1 },
  ],
  sunset: [
    { pos: 0, r: 0.1, g: 0.02, b: 0.25 },
    { pos: 0.5, r: 0.9, g: 0.25, b: 0.3 },
    { pos: 1, r: 1, g: 0.9, b: 0.5 },
  ],
  duotone: [
    { pos: 0, r: 0.08, g: 0.1, b: 0.4 },
    { pos: 1, r: 1, g: 0.6, b: 0.2 },
  ],
  noir: [
    { pos: 0, r: 0, g: 0, b: 0 },
    { pos: 1, r: 1, g: 1, b: 1 },
  ],
};

function realAdjustments(): AdjustmentInfo[] {
  const c3 = (t: string) => `Shifts the ${t}.`;
  return [
    adj("hsb", "Hue, saturation, brightness", "adjust", "Shift colours around the wheel, richer or greyer, lighter or darker.", [
      num("hue", "Hue", -180, 180, 0, "Rotate every colour around the wheel.", { step: 1, unit: "°" }),
      num("saturation", "Saturation", -100, 100, 0, "Greyer to the left, richer to the right.", { step: 1, unit: "%" }),
      num("brightness", "Brightness", -100, 100, 0, "Darker to the left, lighter to the right.", { step: 1, unit: "%" }),
    ], (v) => (src) => hsb(src, { hue: n(v, "hue"), saturation: n(v, "saturation") / 100, brightness: n(v, "brightness") / 100 })),
    adj("balance", "Colour balance", "color", "Tint the shadows, midtones and highlights separately.", [
      num("sR", "Shadows C–R", -100, 100, 0, c3("shadows toward cyan or red"), { step: 1 }),
      num("sG", "Shadows M–G", -100, 100, 0, c3("shadows toward magenta or green"), { step: 1 }),
      num("sB", "Shadows Y–B", -100, 100, 0, c3("shadows toward yellow or blue"), { step: 1 }),
      num("mR", "Mids C–R", -100, 100, 0, c3("midtones toward cyan or red"), { step: 1 }),
      num("mG", "Mids M–G", -100, 100, 0, c3("midtones toward magenta or green"), { step: 1 }),
      num("mB", "Mids Y–B", -100, 100, 0, c3("midtones toward yellow or blue"), { step: 1 }),
      num("hR", "Lights C–R", -100, 100, 0, c3("highlights toward cyan or red"), { step: 1 }),
      num("hG", "Lights M–G", -100, 100, 0, c3("highlights toward magenta or green"), { step: 1 }),
      num("hB", "Lights Y–B", -100, 100, 0, c3("highlights toward yellow or blue"), { step: 1 }),
      { id: "keep", label: "Keep brightness", type: "toggle", default: true, tip: "Hold the picture's lightness steady while tinting." },
    ], (v) => (src) =>
      colorBalance(src, {
        shadows: [n(v, "sR") / 100, n(v, "sG") / 100, n(v, "sB") / 100],
        midtones: [n(v, "mR") / 100, n(v, "mG") / 100, n(v, "mB") / 100],
        highlights: [n(v, "hR") / 100, n(v, "hG") / 100, n(v, "hB") / 100],
        preserveLuminosity: v["keep"] !== false,
      })),
    adj("curves", "Curves", "adjust", "Bend the tones: lift the shadows, push the highlights.", [
      { id: "channel", label: "Channel", type: "choice", default: "master", choices: [{ value: "master", label: "All" }, { value: "r", label: "R" }, { value: "g", label: "G" }, { value: "b", label: "B" }], tip: "Which channel the curve changes." },
      num("shadows", "Shadows", -100, 100, 0, "Lift or sink the dark quarter of the range.", { step: 1, unit: "%" }),
      num("mids", "Midtones", -100, 100, 0, "Lift or sink the middle of the range.", { step: 1, unit: "%" }),
      num("lights", "Highlights", -100, 100, 0, "Lift or sink the bright quarter of the range.", { step: 1, unit: "%" }),
    ], (v) => {
      const at = (x: number, d: number) => Math.max(0, Math.min(1, x + (d / 100) * 0.25));
      const curve: Array<[number, number]> = [[0, 0], [0.25, at(0.25, n(v, "shadows"))], [0.5, at(0.5, n(v, "mids"))], [0.75, at(0.75, n(v, "lights"))], [1, 1]];
      const ch = String(v["channel"] ?? "master");
      return (src) => curves(src, ch === "master" ? { master: curve } : { [ch]: curve });
    }),
    adj("gradientmap", "Gradient map", "duotone", "Recolour the picture by brightness along a gradient.", [
      { id: "preset", label: "Gradient", type: "choice", default: "sepia", choices: [{ value: "sepia", label: "Sepia" }, { value: "cool", label: "Cool" }, { value: "sunset", label: "Sunset" }, { value: "duotone", label: "Duo" }, { value: "noir", label: "Noir" }], tip: "The gradient dark-to-light is mapped onto." },
      { id: "reverse", label: "Reverse", type: "toggle", default: false, tip: "Light becomes dark and dark becomes light." },
    ], (v) => {
      const stops = GRADIENTS[String(v["preset"] ?? "sepia")] ?? GRADIENTS["sepia"]!;
      const used = v["reverse"] === true ? stops.map((s) => ({ ...s, pos: 1 - s.pos })) : stops;
      return (src) => gradientMap(src, used);
    }),
    adj("blur", "Gaussian blur", "smear", "Soften the layer.", [num("radius", "Radius", 0, 100, 8, "How far the softening reaches.", { step: 0.5, unit: "px", curve: "exp" })], (v) => (src) => gaussianBlur(src, n(v, "radius"))),
    adj("motionblur", "Motion blur", "smear", "Smear the layer along a direction.", [
      num("angle", "Angle", 0, 180, 0, "The direction of the smear.", { step: 1, unit: "°" }),
      num("distance", "Distance", 1, 200, 24, "How long the smear is.", { step: 1, unit: "px", curve: "exp" }),
    ], (v) => (src) => motionBlur(src, n(v, "angle"), n(v, "distance"))),
    adj("sharpen", "Sharpen", "sparkle", "Bring out edges and fine detail.", [
      num("amount", "Amount", 0, 3, 1, "How strongly edges are pushed.", { step: 0.05 }),
      num("radius", "Radius", 0.5, 10, 1.5, "How wide an edge counts.", { step: 0.1, unit: "px" }),
    ], (v) => (src) => sharpen(src, n(v, "amount"), n(v, "radius"))),
    adj("noise", "Noise", "particles", "Add film grain.", [
      num("amount", "Amount", 0, 100, 20, "How strong the grain is.", { step: 1, unit: "%" }),
      { id: "mono", label: "Mono", type: "toggle", default: true, tip: "The same grain on every colour channel." },
      num("seed", "Seed", 1, 9999, 1, "Another number, another grain pattern.", { step: 1 }),
    ], (v) => (src) => noise(src, { amount: n(v, "amount") / 100, mono: v["mono"] !== false, seed: n(v, "seed") || 1 })),
    { id: "liquify", label: "Liquify", icon: "smear", available: true, liquify: true },
  ];
}

function handleOf(s: AdjustSession): AdjustHandle {
  return {
    preview: (e) => s.preview(e),
    render: (e) => void s.render(e),
    applyThroughMask: (mask, at) => void s.applyThroughMask(mask, at),
    commit: () => void s.commit(),
    cancel: () => s.cancel(),
  };
}

// ---- Perception ----

const impl = (q: unknown) => q as PerceptionQueueImpl;

const quiet = (e: unknown): void => {
  if (e instanceof CancelledError) return;
  throw e;
};

function canvasDataURL(img: ImageData): string {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")?.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

export const realRuntime: Partial<PaintRuntime> = {
  createEngine: () => createPaintEngine({ resolver: assetResolver }),
  brushLibrary: (): BrushPreset[] => LIBRARY_PRESETS,
  brushSetNames: () => Object.fromEntries([...SET_NAMES, ...new Set(LIBRARY_PRESETS.map((p) => p.set))].map((n) => [n, n])),
  assetChoices: choices,
  applyGuides: (engine, g) => {
    const e = engine as Partial<Ext>;
    if (!e.setGuides || !e.getGuides) return;
    e.setGuides(toEngineGuides(g, e.getGuides(), { w: engine.doc.width, h: engine.doc.height }));
  },
  warm: warmOnce,
  grainImage: async (ref) => (await assetResolver(ref)) ?? null,
  createQueue: (engine, projectId) => createPerceptionQueue(engine, projectId),
  createObjectSelector: ({ engine, queue, params }) => createObjectSelector(impl(queue), engine, params),
  createStampTips: ({ engine, queue }) => {
    activeTips = createStampTips(impl(queue), engine);
    return activeTips;
  },
  runPerceptionStroke: async ({ engine, queue, tool, params, result, seed }) => {
    try {
      if (tool.id === "enhance-brush") await runEnhanceBrush(impl(queue), engine, params, result, seed);
      else if (tool.op === "fill") await runFillTool(impl(queue), engine, tool.id, params, result, seed);
    } catch (e) {
      quiet(e);
    }
  },
  extendCanvas: async ({ engine, queue, sides, model }) => {
    try {
      await extendCanvasWithFill(impl(queue), engine, sides, { quality: model }, Math.floor(Math.random() * 0x7fffffff));
    } catch (e) {
      quiet(e);
    }
  },
  upscaleCanvas: async ({ engine, queue, name, scale, inPlace }) => {
    try {
      const r = await upscaleCanvas(impl(queue), engine, { scale, target: inPlace ? "inplace" : "new" }, { name: `${name} x${scale}`, encodeTile: async (img) => canvasDataURL(img) });
      return r.projectId;
    } catch (e) {
      quiet(e);
      return "";
    }
  },
  runLabAction: async (toolId, { engine, queue, params = {} }) => {
    try {
      if (toolId === "select-subject") await selectSubject(impl(queue), engine, params);
      else if (toolId === "cut-subject") await cutSubjectToNewLayer(impl(queue), engine, params);
      else throw new Error(`No such Lab action: ${toolId}`);
    } catch (e) {
      quiet(e);
    }
  },
  adjustments: realAdjustments,
  beginAdjust: (engine, label) => {
    const s = AdjustSession.begin(engine as Ext, label);
    return s ? handleOf(s) : null;
  },
  beginLiquify: (engine, label) => {
    const s = AdjustSession.begin(engine as Ext, label);
    if (!s) return null;
    const field = new LiquifyField(s.rect.w, s.rect.h, 7);
    const handle: LiquifyHandle = {
      dab: (mode, x, y, radius, strength, mx, my) => field.dab(mode, x - s.rect.x, y - s.rect.y, radius, strength, mx, my),
      effect: () => (src) => field.apply(src),
      rect: () => s.rect,
    };
    return { adjust: handleOf(s), field: handle };
  },
};


/** Switches the editor to the real engine and library. Call once, before the first painting opens. */
export function enableRealRuntime(): void {
  setRuntime(realRuntime);
}

export { parseGuides };
