// An adjustment session: snapshot a layer region (the selection's bounds, or
// the whole layer), re-run an effect from the snapshot as parameters change
// (live preview, no history), then commit as one undo step, or apply it only
// where the user paints ("Pencil" mode: strokes of a `mask` tool call
// applyThroughMask, one step each).

import type { PaintEngineExt } from "../engine/engine";
import { makeImageData, straightImage } from "../engine/pixels";
import type { HistoryId, PaintEngine, Rect } from "../engine/types";
import type { Img } from "./color";

export type Effect = (src: Img) => ImageData;

export class AdjustSession {
  readonly rect: Rect;
  private readonly snap: ImageData;
  private pv: ReturnType<PaintEngineExt["beginPreview"]> | null = null;
  private last: ImageData | null = null;

  private constructor(
    private readonly engine: PaintEngine & PaintEngineExt,
    private readonly layerId: string,
    rect: Rect,
    snap: ImageData,
    private readonly label: string,
  ) {
    this.rect = rect;
    this.snap = snap;
  }

  static begin(engine: PaintEngine & PaintEngineExt, label = "Adjustment"): AdjustSession | null {
    const layerId = engine.doc.active;
    const rect = engine.selection.bounds() ?? { x: 0, y: 0, w: engine.doc.width, h: engine.doc.height };
    if (rect.w <= 0 || rect.h <= 0) return null;
    const snap = straightImage(engine.readPixels(rect, "layer"));
    return new AdjustSession(engine, layerId, rect, snap, label);
  }

  /** Run the effect on the snapshot and show it (through the selection). */
  preview(effect: Effect): void {
    this.last = effect(this.snap);
    this.pv ??= this.engine.beginPreview(this.layerId);
    this.pv.set(this.rect, this.last);
  }

  /** The effect's last result without touching the layer (for Pencil mode). */
  render(effect: Effect): ImageData {
    this.last = effect(this.snap);
    return this.last;
  }

  commit(): HistoryId {
    const id = this.pv ? this.pv.commit(this.label) : 0;
    this.pv = null;
    return id;
  }

  cancel(): void {
    this.pv?.cancel();
    this.pv = null;
  }

  /**
   * Pencil mode: apply the last rendered effect only under `mask` (the stroke's
   * mask, placed at `at`), as one undo step. The snapshot is refreshed so later
   * strokes build on this one.
   */
  applyThroughMask(mask: ImageData, at: { x: number; y: number }): HistoryId {
    if (!this.last) return 0;
    const r: Rect = { x: this.rect.x, y: this.rect.y, w: this.rect.w, h: this.rect.h };
    const full = makeImageData(r.w, r.h);
    for (let y = 0; y < mask.height; y++) {
      const fy = y + at.y - r.y;
      if (fy < 0 || fy >= r.h) continue;
      for (let x = 0; x < mask.width; x++) {
        const fx = x + at.x - r.x;
        if (fx < 0 || fx >= r.w) continue;
        full.data[(fy * r.w + fx) * 4 + 3] = mask.data[(y * mask.width + x) * 4 + 3] as number;
      }
    }
    return this.engine.writeRegion(this.layerId, r, this.last, full, 0, `${this.label} (pencil)`);
  }
}
