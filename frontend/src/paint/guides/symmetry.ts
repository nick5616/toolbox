// Symmetry guides: every stroke point is replicated by the guide's transforms
// (mirror across a vertical/horizontal axis, both, or N-fold rotation).

export type SymmetryMode = "off" | "vertical" | "horizontal" | "quadrant" | "radial";

export interface SymmetryConfig {
  mode: SymmetryMode;
  /** Radial: 2..16 copies. */
  count: number;
  /** Axis / centre in canvas px. */
  cx: number;
  cy: number;
}

export const NO_SYMMETRY: SymmetryConfig = { mode: "off", count: 2, cx: 0, cy: 0 };

/** How many copies of a stroke the guide makes (1 = off). */
export function copyCount(c: SymmetryConfig): number {
  switch (c.mode) {
    case "vertical":
    case "horizontal":
      return 2;
    case "quadrant":
      return 4;
    case "radial":
      return Math.max(2, Math.min(16, Math.round(c.count)));
    default:
      return 1;
  }
}

/** Copy k (0 = the stroke itself) of the point (x, y). */
export function mapPoint(c: SymmetryConfig, k: number, x: number, y: number, out: { x: number; y: number }): void {
  if (k === 0 || c.mode === "off") {
    out.x = x;
    out.y = y;
    return;
  }
  switch (c.mode) {
    case "vertical":
      out.x = 2 * c.cx - x;
      out.y = y;
      return;
    case "horizontal":
      out.x = x;
      out.y = 2 * c.cy - y;
      return;
    case "quadrant":
      out.x = k & 1 ? 2 * c.cx - x : x;
      out.y = k & 2 ? 2 * c.cy - y : y;
      return;
    case "radial": {
      const n = copyCount(c);
      const a = (2 * Math.PI * k) / n;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const dx = x - c.cx;
      const dy = y - c.cy;
      out.x = c.cx + dx * cs - dy * sn;
      out.y = c.cy + dx * sn + dy * cs;
      return;
    }
  }
}

/** Whether copy k mirrors (flips the tip's handedness / tilt direction). */
export function isMirrored(c: SymmetryConfig, k: number): boolean {
  if (k === 0) return false;
  if (c.mode === "vertical" || c.mode === "horizontal") return true;
  if (c.mode === "quadrant") return k === 1 || k === 2;
  return false;
}
