// The brushes PaintLab renders: every bundled library preset (our own 64 and
// the open sets) plus four built-ins that need no images.

import type { AssetImage, AssetResolver } from "../brushes/assets";
import { defaultBrush } from "../brushes/defaults";
import { LIBRARY_PRESETS, resolveLibraryAsset } from "../brushes/library";
import type { BrushPreset } from "../brushes/schema";

const bareUrls = import.meta.glob("../brushes/library/**/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export const BUILTIN: BrushPreset[] = [
  // A coloured stamp (like Subject stamp's cut-outs): paints its own colours, not the ink's.
  defaultBrush({
    id: "lab-colour-stamp",
    name: "Colour stamp (own colours)",
    set: "Built-in",
    size: 56,
    spacing: 1.1,
    scatter: 0.15,
    tip: { shape: "stamp:lab", hardness: 0, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0.15, invert: false },
    dynamics: [{ input: "pressure", target: "size", amount: 0.5, curve: [[0, 0], [1, 1]] }],
    minSize: 0.5,
  }),
  defaultBrush({ id: "lab-hard-round", name: "Hard round", set: "Built-in", size: 18, dynamics: [{ input: "pressure", target: "size", amount: 1, curve: [[0, 0], [1, 1]] }], minSize: 0.15 }),
  defaultBrush({ id: "lab-soft-round", name: "Soft round", set: "Built-in", size: 40, flow: 0.35, tip: { shape: "round", hardness: 0, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false }, spacing: 0.08 }),
  defaultBrush({
    id: "lab-flat-oil",
    name: "Flat oil (wet)",
    set: "Built-in",
    size: 30,
    tip: { shape: "square", hardness: 1, roundness: 0.35, angle: 30, angleMode: "stroke", rotationJitter: 0, invert: false },
    wet: { mix: 0.6, dilution: 0.1, charge: 0.7, pull: 0.5, grade: 0.3, edges: 0, bleed: 0 },
    rendering: "heavy",
    impasto: 0.6,
  }),
  defaultBrush({
    id: "lab-scatter-dots",
    name: "Scatter dots",
    set: "Built-in",
    size: 12,
    scatter: 1.4,
    count: 3,
    spacing: 0.9,
    color: { hueJitter: 0.25, satJitter: 0.1, briJitter: 0.1, perStroke: false, secondaryMix: 0 },
  }),
];

/** The built-ins plus every bundled preset, de-duplicated by id. */
export function allPresets(only?: string | null): BrushPreset[] {
  const seen = new Set<string>();
  const all: BrushPreset[] = [];
  for (const p of [...BUILTIN, ...LIBRARY_PRESETS]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    all.push(p);
  }
  return only ? all.filter((p) => p.id === only) : all;
}

/** `lib:<path>` → the bundled PNG (`tips/x.png`, `open/krita/tips/x.png`; a bare file name is searched for). */
/** A little flower with a yellow centre, drawn in code: a coloured cut-out with soft edges and transparency. */
function labStamp(): AssetImage {
  const n = 96;
  const c = new OffscreenCanvas(n, n);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.translate(n / 2, n / 2);
  const petals = ["#e8463c", "#f08a2c", "#d93a7a", "#9b4bd6", "#3c7be8"];
  for (let k = 0; k < 10; k++) {
    ctx.save();
    ctx.rotate((k / 10) * Math.PI * 2);
    const g = ctx.createLinearGradient(0, 0, 0, -n * 0.46);
    g.addColorStop(0, "#fff3c0");
    g.addColorStop(1, petals[k % petals.length] as string);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -n * 0.27, n * 0.085, n * 0.19, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = "#ffd23c";
  ctx.beginPath();
  ctx.arc(0, 0, n * 0.1, 0, Math.PI * 2);
  ctx.fill();
  const d = ctx.getImageData(0, 0, n, n);
  return { data: d.data, width: n, height: n };
}

export const libResolver: AssetResolver = async (ref) => {
  if (ref === "stamp:lab") return labStamp();
  if (!ref.startsWith("lib:")) return null;
  let url: string;
  try {
    url = resolveLibraryAsset(ref);
  } catch {
    const file = ref.slice(4);
    const key = Object.keys(bareUrls).find((k) => k.endsWith(`/${file}`));
    if (!key) return null;
    url = bareUrls[key] as string;
  }
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  const img: AssetImage = { data: d.data, width: d.width, height: d.height };
  return img;
};
