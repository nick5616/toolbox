import type { PaintDoc } from "../engine/types";

/** A one-layer blank document for PaintLab. */
export function blankDocForLab(width: number, height: number, background: string): PaintDoc {
  return {
    version: 1,
    width,
    height,
    background,
    layers: [{ id: "l1", name: "Layer 1", hidden: false, locked: false, alphaLock: false, clip: false, reference: false, opacity: 1, blend: "normal", tiles: [], rev: 0 }],
    active: "l1",
    palette: [],
    guides: "",
    tileSize: 512,
    source: "",
  };
}
