// Pixel sort: sorts the pixels under the stroke along its direction, inside the
// runs whose brightness lies between two thresholds. Exact.

import type { InputPoint } from "../engine/types";
import { luma, makeImage, maskFromCoverage, num, pointsBounds, present, rasterizeStroke, Serial, str, strokeHardness, strokeRadius } from "./common";
import { ext, type AsyncLabTool } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  { id: "low", label: "Sort from", type: "number", min: 0, max: 1, step: 0.01, default: 0.2, tip: "Pixels darker than this stay put and break the sorted runs." },
  { id: "high", label: "Sort up to", type: "number", min: 0, max: 1, step: 0.01, default: 0.9, tip: "Pixels brighter than this stay put and break the sorted runs." },
  {
    id: "direction",
    label: "Direction",
    type: "choice",
    choices: [
      { value: "stroke", label: "Along the stroke" },
      { value: "horizontal", label: "Left to right" },
      { value: "vertical", label: "Top to bottom" },
    ],
    default: "stroke",
    tip: "Which way pixels slide. Along the stroke follows the way you dragged from start to end.",
  },
  {
    id: "order",
    label: "Order",
    type: "choice",
    choices: [
      { value: "dark-first", label: "Dark first" },
      { value: "bright-first", label: "Bright first" },
    ],
    default: "dark-first",
    tip: "Whether each run goes from dark to bright or the other way round.",
  },
];

/** Strokes bigger than this are only sorted once, at the end. */
const LIVE_AREA = 300_000;

export interface SortOptions {
  low: number;
  high: number;
  /** Radians. */
  angle: number;
  brightFirst: boolean;
}

/**
 * Sorts `src` (straight RGBA) along lines at `angle` inside `cover` (coverage
 * per pixel). Returns the new pixels; uncovered pixels are copied.
 */
export function sortPixels(src: ImageData, cover: Float32Array, o: SortOptions): ImageData {
  const w = src.width;
  const h = src.height;
  const out = makeImage(w, h, new Uint8ClampedArray(src.data));
  const dx = Math.cos(o.angle);
  const dy = Math.sin(o.angle);
  const nx = -dy;
  const ny = dx;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.ceil(Math.hypot(w, h) / 2) + 1;
  const idx: number[] = [];
  const lum: number[] = [];
  const flushRun = (from: number, to: number) => {
    // idx[from..to) is one run of sortable pixels
    const n = to - from;
    if (n < 2) return;
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => {
      const d = (lum[from + a] as number) - (lum[from + b] as number);
      return d !== 0 ? (o.brightFirst ? -d : d) : a - b;
    });
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const s = (idx[from + (order[i] as number)] as number) * 4;
      px.set(src.data.subarray(s, s + 4), i * 4);
    }
    for (let i = 0; i < n; i++) out.data.set(px.subarray(i * 4, i * 4 + 4), (idx[from + i] as number) * 4);
  };
  for (let j = -R; j <= R; j++) {
    idx.length = 0;
    lum.length = 0;
    let run = 0;
    let prevPix = -1;
    const finishRun = () => {
      flushRun(run, idx.length);
      run = idx.length;
    };
    for (let t = -R; t <= R; t++) {
      const x = Math.round(cx + t * dx + j * nx - 0.5);
      const y = Math.round(cy + t * dy + j * ny - 0.5);
      if (x < 0 || y < 0 || x >= w || y >= h) {
        if (idx.length > run) finishRun();
        continue;
      }
      const pix = y * w + x;
      if (pix === prevPix) continue;
      prevPix = pix;
      const l = luma(src.data[pix * 4] as number, src.data[pix * 4 + 1] as number, src.data[pix * 4 + 2] as number);
      const inside = (cover[pix] as number) > 0.5 && (src.data[pix * 4 + 3] as number) > 0 && l >= o.low && l <= o.high;
      if (!inside) {
        if (idx.length > run) finishRun();
        run = idx.length;
        continue;
      }
      idx.push(pix);
      lum.push(l);
    }
    if (idx.length > run) finishRun();
  }
  return out;
}

export function createPixelSort(): AsyncLabTool {
  const q = new Serial();
  let pts: InputPoint[] = [];

  const render = (ctx: LabContext, final: boolean) => {
    if (!final && !ext(ctx).clearScratch) return; // nothing could show a live preview
    const snapshot = pts.slice();
    q.run(async () => {
      const radius = strokeRadius(ctx);
      const rect = pointsBounds(snapshot, radius + 1);
      if (!final && rect.w * rect.h > LIVE_AREA) return;
      const [src, cov] = [await ctx.snapshot(rect), rasterizeStroke(snapshot, radius, strokeHardness(ctx), rect, 1)];
      const first = snapshot[0] as InputPoint;
      const last = snapshot[snapshot.length - 1] as InputPoint;
      const mode = str(ctx.params, "direction", "stroke");
      const angle = mode === "horizontal" ? 0 : mode === "vertical" ? Math.PI / 2 : Math.hypot(last.x - first.x, last.y - first.y) < 1 ? 0 : Math.atan2(last.y - first.y, last.x - first.x);
      const out = sortPixels(src, cov.data, {
        low: num(ctx.params, "low", 0.2),
        high: num(ctx.params, "high", 0.9),
        angle,
        brightFirst: str(ctx.params, "order", "dark-first") === "bright-first",
      });
      present(ctx, rect, out, maskFromCoverage(cov.data, cov.w, cov.h), final);
    });
  };

  return {
    id: "pixel-sort",
    label: "Pixel sort",
    description: "Sorts the pixels under your stroke by brightness, so picture detail streaks along it.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "The picture under your stroke is read along lines that run in the direction you dragged. On each line, every unbroken run of pixels whose brightness is between your two thresholds is rearranged from dark to bright (or the reverse). Pixels outside the thresholds stay where they are and mark the ends of runs. It is an ordinary sort, so the same stroke always gives the same result.",
    },
    params: PARAMS,
    icon: "pixel-sort",
    onStrokeBegin(_ctx, p) {
      pts = [p];
    },
    onStrokeExtend(ctx, points) {
      pts.push(...points);
      render(ctx, false);
    },
    onStrokeEnd(ctx) {
      render(ctx, true);
    },
    flush: () => q.flush(),
  };
}
