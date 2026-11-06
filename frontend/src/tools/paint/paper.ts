/**
 * Paper texture for a new canvas (SPEC §1.1): a grain baked into a locked
 * bottom layer. The gallery marks the new project; the editor, once it has
 * loaded the document, runs the job exactly once.
 */
import type { PaintEngine } from "@/paint/engine/types";
import { runtime } from "./engine-adapter";

export const PAPER_GRAIN = "lib:grains/paper.png";

type Job = (engine: PaintEngine) => Promise<void>;

const pending = new Map<string, Job>();

export function markPaper(projectId: string): void {
  pending.set(projectId, paintPaper);
}

export function takePaper(projectId: string): Job | undefined {
  const j = pending.get(projectId);
  pending.delete(projectId);
  return j;
}

/** A near-white sheet of the grain's speckle (about ±8% around white), tiled over the canvas. Pure, for tests. */
export function paperPixels(grain: { data: Uint8ClampedArray; width: number; height: number }, w: number, h: number): Uint8ClampedArray {
  const lum = new Float32Array(grain.width * grain.height);
  let mean = 0;
  for (let i = 0; i < lum.length; i++) {
    const a = (grain.data[i * 4 + 3] as number) / 255;
    lum[i] = (0.3 * (grain.data[i * 4] as number) + 0.59 * (grain.data[i * 4 + 1] as number) + 0.11 * (grain.data[i * 4 + 2] as number)) * a + 255 * (1 - a);
    mean += lum[i] as number;
  }
  mean /= Math.max(1, lum.length);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (y % grain.height) * grain.width;
    for (let x = 0; x < w; x++) {
      const v = 247 + ((lum[row + (x % grain.width)] as number) - mean) * 0.2;
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = Math.max(0, Math.min(255, v));
      out[o + 3] = 255;
    }
  }
  return out;
}

async function paintPaper(engine: PaintEngine): Promise<void> {
  const grain = await runtime.grainImage(PAPER_GRAIN);
  if (!grain) return;
  const w = engine.doc.width;
  const h = engine.doc.height;
  const active = engine.doc.active;
  const id = engine.addLayer({ name: "Paper", blend: "multiply" }, 0);
  const px = paperPixels(grain, w, h);
  engine.writeRegion(id, { x: 0, y: 0, w, h }, new ImageData(px as Uint8ClampedArray<ArrayBuffer>, w, h), undefined, 0, "Paper texture");
  engine.setLayer(id, { locked: true });
  if (active) engine.setActive(active);
}
