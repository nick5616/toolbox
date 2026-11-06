import type { PaintEngineExt } from "@/paint/engine/engine";
import type { PaintEngine } from "@/paint/engine/types";
import { translate, type Affine } from "./transformMath";

/** Moves the running transform by (dx, dy) canvas px, whatever its mode (the body drag on the canvas). */
export function applyTransformDrag(engine: PaintEngine, dx: number, dy: number): void {
  const st = (engine as Partial<PaintEngineExt>).transformState?.();
  if (!st) {
    engine.transform.set({ matrix: [1, 0, 0, 1, dx, dy] });
    return;
  }
  const shift = (ps: Array<{ x: number; y: number }>) => ps.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (st.mode === "warp") engine.transform.set({ mesh: shift(st.mesh) });
  else if (st.mode === "distort") engine.transform.set({ corners: shift(st.corners) });
  else engine.transform.set({ matrix: translate(st.matrix as Affine, dx, dy) });
}
