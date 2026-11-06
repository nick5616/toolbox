import type { BrushPreset } from "@/paint/brushes/schema";
import type { StrokePreviewOptions } from "../engine-adapter";

const IS_JSDOM = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

/** A built-in S-curve with a pressure swell, used for library previews. */
export function sCurve(w: number, h: number): Array<{ x: number; y: number; pressure: number }> {
  const pts: Array<{ x: number; y: number; pressure: number }> = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: w * (0.08 + 0.84 * t), y: h * (0.5 + 0.28 * Math.sin(t * Math.PI * 2)), pressure: Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.05)) * 0.8 + 0.2 });
  }
  return pts;
}

/** Draws `brush` along a path with round dabs (a stand-in for the engine's stroke renderer). */
export function renderFakeStroke(brush: BrushPreset, canvas: HTMLCanvasElement, opts: StrokePreviewOptions = {}): void {
  if (IS_JSDOM) return;
  const g = canvas.getContext("2d");
  if (!g) return;
  const w = canvas.width;
  const h = canvas.height;
  g.clearRect(0, 0, w, h);
  if (opts.background) {
    g.fillStyle = opts.background;
    g.fillRect(0, 0, w, h);
  }
  const pts = opts.points && opts.points.length ? opts.points : sCurve(w, h);
  const scale = Math.min(1, (h * 0.5) / Math.max(1, brush.size));
  const color = opts.color ?? "#cfcfd6";
  g.fillStyle = color;
  g.globalAlpha = Math.max(0.1, brush.opacity * 0.5);
  let prev = pts[0];
  for (const p of pts.slice(1)) {
    if (!prev) break;
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    const size = Math.max(1, brush.size * scale * (brush.minSize + (1 - brush.minSize) * p.pressure));
    const step = Math.max(1, size * Math.max(0.05, brush.spacing));
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) {
      const x = prev.x + ((p.x - prev.x) * i) / n;
      const y = prev.y + ((p.y - prev.y) * i) / n;
      g.beginPath();
      g.arc(x + (brush.scatter ? (Math.sin(x * 12.9898 + y) * brush.scatter * size) / 2 : 0), y, size / 2, 0, Math.PI * 2);
      g.fill();
    }
    prev = p;
  }
  g.globalAlpha = 1;
}
