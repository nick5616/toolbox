/**
 * The real modules behind the seam (engine-adapter.ts): P1's engine, B1's
 * bundled library, the engine's guides. NOT active by default (the tests and
 * `npm run dev` without a GPU use the fakes). The architect turns it on with
 * one call: `enableRealRuntime()` (for example at the top of PaintView.tsx).
 *
 * Not wired here, on purpose: P6's queue and perception strokes (they need the
 * project id, which the editor has), and `attachInput` (canvasInput.ts is a
 * complete input layer: P1's `attachPointer` only draws, it doesn't navigate).
 */
import { PaintService } from "@/lib/api";
import type { AssetImage, AssetResolver } from "@/paint/brushes/assets";
import { LIBRARY_PRESETS, SET_NAMES, resolveLibraryAsset } from "@/paint/brushes/library";
import type { BrushPreset } from "@/paint/brushes/schema";
import { createPaintEngine, type PaintEngineExt } from "@/paint/engine/engine";
import type { PaintEngine } from "@/paint/engine/types";
import { parseGuides, type GuidesConfig } from "@/paint/guides/guides";
import { setRuntime, type GuidesState, type PaintRuntime } from "./engine-adapter";

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

/** "lib:<file>" from the bundled library, "set:<id>/<file>" from a user or imported set. */
export const assetResolver: AssetResolver = async (ref) => {
  try {
    if (ref.startsWith("lib:")) return await toImage(resolveLibraryAsset(ref));
    if (ref.startsWith("set:")) {
      const [set, ...file] = ref.slice(4).split("/");
      return await toImage(await PaintService.BrushAsset(set ?? "", file.join("/")));
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

type Ext = PaintEngine & Partial<PaintEngineExt>;

export const realRuntime: Partial<PaintRuntime> = {
  createEngine: () => createPaintEngine({ resolver: assetResolver }),
  brushLibrary: (): BrushPreset[] => LIBRARY_PRESETS,
  brushSetNames: () => Object.fromEntries([...SET_NAMES, ...new Set(LIBRARY_PRESETS.map((p) => p.set))].map((n) => [n, n])),
  assetChoices: choices,
  applyGuides: (engine, g) => {
    const e = engine as Ext;
    if (!e.setGuides || !e.getGuides) return;
    e.setGuides(toEngineGuides(g, e.getGuides(), { w: engine.doc.width, h: engine.doc.height }));
  },
};

/** Switches the editor to the real engine and library. Call once, before the first painting opens. */
export function enableRealRuntime(): void {
  setRuntime(realRuntime);
}

export { parseGuides };
