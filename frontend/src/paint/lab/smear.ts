// Smear / Liquify brush: pushes pixels along the stroke. The displacement field
// accumulates dab by dab and the picture is always resampled from the
// stroke-start snapshot, so results never blur from repeated resampling. Exact.

import type { Rect } from "../engine/types";
import { clamp, makeImage, num, present, Resampler, sampleBilinear, Serial, smoothstep, strokeRadius, unionRect, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import { ext } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  { id: "strength", label: "Strength", type: "number", min: 0.1, max: 2, step: 0.05, default: 0.9, tip: "How far pixels travel compared to your hand. 1 follows the pen exactly." },
  { id: "softness", label: "Softness", type: "number", min: 0, max: 1, step: 0.05, default: 0.5, tip: "How gently the push fades out toward the edge of the brush." },
];

const CH = 32;

/** A sparse displacement field in 32 px chunks. */
export class Displacement {
  private chunks = new Map<string, Float32Array>();
  bounds: Rect | null = null;
  maxMag = 0;

  private chunk(cx: number, cy: number): Float32Array {
    const key = `${cx},${cy}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = new Float32Array(CH * CH * 2);
      this.chunks.set(key, c);
    }
    return c;
  }

  /** Adds a push of (mx, my) with a soft disc of radius r at (x, y). */
  push(x: number, y: number, r: number, mx: number, my: number, softness: number): void {
    const x0 = Math.floor(x - r);
    const y0 = Math.floor(y - r);
    const x1 = Math.ceil(x + r);
    const y1 = Math.ceil(y + r);
    const cap = r * 2;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = Math.hypot(px + 0.5 - x, py + 0.5 - y) / r;
        if (d >= 1) continue;
        const wt = softness <= 0 ? 1 : Math.pow(1 - d * d, 1 + softness * 2);
        const cx = Math.floor(px / CH);
        const cy = Math.floor(py / CH);
        const c = this.chunk(cx, cy);
        const k = ((py - cy * CH) * CH + (px - cx * CH)) * 2;
        let ux = (c[k] as number) + mx * wt;
        let uy = (c[k + 1] as number) + my * wt;
        const m = Math.hypot(ux, uy);
        if (m > cap) {
          ux *= cap / m;
          uy *= cap / m;
        }
        c[k] = ux;
        c[k + 1] = uy;
        if (m > this.maxMag) this.maxMag = Math.min(m, cap);
      }
    }
    this.bounds = unionRect(this.bounds, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }

  at(px: number, py: number): [number, number] {
    const cx = Math.floor(px / CH);
    const cy = Math.floor(py / CH);
    const c = this.chunks.get(`${cx},${cy}`);
    if (!c) return [0, 0];
    const k = ((py - cy * CH) * CH + (px - cx * CH)) * 2;
    return [c[k] as number, c[k + 1] as number];
  }
}

/** Renders the displaced picture of `src` (the snapshot of `rect` padded by `pad`) over `rect`. */
export function renderSmear(disp: Displacement, src: ImageData, rect: Rect, pad: number): { img: ImageData; mask: ImageData } {
  const img = makeImage(rect.w, rect.h);
  const mask = makeImage(rect.w, rect.h);
  const tmp = [0, 0, 0, 0];
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const [ux, uy] = disp.at(rect.x + x, rect.y + y);
      const mag = Math.hypot(ux, uy);
      if (mag < 0.02) continue;
      sampleBilinear(src, x + pad + 0.5 - ux, y + pad + 0.5 - uy, tmp);
      const k = (y * rect.w + x) * 4;
      img.data[k] = tmp[0] as number;
      img.data[k + 1] = tmp[1] as number;
      img.data[k + 2] = tmp[2] as number;
      img.data[k + 3] = tmp[3] as number;
      mask.data.fill(255, k, k + 3);
      mask.data[k + 3] = Math.round(smoothstep(0, 1.5, mag) * 255);
    }
  }
  return { img, mask };
}

export function createSmear(): AsyncLabTool {
  const q = new Serial();
  let rs = new Resampler(4);
  let disp = new Displacement();
  let prev: Sample | null = null;

  const apply = (ctx: LabContext, samples: Sample[]) => {
    const r = strokeRadius(ctx);
    const strength = num(ctx.params, "strength", 0.9);
    const soft = num(ctx.params, "softness", 0.5);
    for (const s of samples) {
      if (prev) disp.push(s.x, s.y, r * clamp(0.3 + 0.7 * s.pressure, 0.3, 1), (s.x - prev.x) * strength, (s.y - prev.y) * strength, soft);
      prev = s;
    }
  };

  const render = (ctx: LabContext, final: boolean) => {
    if (!disp.bounds) return;
    if (!final && !ext(ctx).clearScratch) return;
    const rect = disp.bounds;
    const pad = Math.ceil(disp.maxMag) + 2;
    q.run(async () => {
      const big: Rect = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
      const src = await ctx.snapshot(big);
      const { img, mask } = renderSmear(disp, src, rect, pad);
      present(ctx, rect, img, mask, final);
    });
  };

  return {
    id: "smear",
    label: "Smear / Liquify",
    description: "Pushes the paint along your stroke like a finger through wet colour.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "As you drag, every pixel under the brush is told to look a little way back along your path for its colour. Those small shifts add up across the stroke, strongest in the middle of the brush and fading to nothing at its edge. The picture is always rebuilt from how it looked when you started the stroke, so it stays sharp. No random numbers are used.",
    },
    params: PARAMS,
    icon: "smear",
    onStrokeBegin(ctx, p) {
      rs = new Resampler(Math.max(2, strokeRadius(ctx) * 0.15));
      disp = new Displacement();
      prev = null;
      rs.begin(p);
    },
    onStrokeExtend(ctx, points) {
      apply(ctx, rs.push(points));
      render(ctx, false);
    },
    onStrokeEnd(ctx) {
      apply(ctx, rs.finish());
      render(ctx, true);
    },
    flush: () => q.flush(),
  };
}
