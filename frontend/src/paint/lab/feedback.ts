// Feedback: each dab zooms and rotates the pixels under it slightly into
// themselves, and later dabs read what earlier dabs made (a tunnel or echo).

import type { Rect } from "../engine/types";
import { clamp, LocalCanvas, makeImage, num, Resampler, sampleBilinear, Serial, stampFalloff, strokeRadius, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  { id: "zoom", label: "Zoom", type: "number", min: 0.85, max: 1.25, step: 0.01, default: 1.05, tip: "How much each dab magnifies what is under it. Above 1 pulls the picture in, below 1 pushes it out." },
  { id: "rotation", label: "Twist", type: "number", min: -45, max: 45, step: 1, default: 4, tip: "How far each dab turns what is under it, in degrees." },
  { id: "strength", label: "Strength", type: "number", min: 0.05, max: 1, step: 0.05, default: 0.6, tip: "How much of the effect each dab applies. Lower values build up slowly." },
];

/** One dab: returns the transformed picture of `src` and its per-pixel weight. */
export function feedbackDab(src: ImageData, radius: number, zoom: number, rotation: number, strength: number): { img: ImageData; weight: Float32Array } {
  const w = src.width;
  const h = src.height;
  const img = makeImage(w, h);
  const weight = new Float32Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const a = (-rotation * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const tmp = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const wt = stampFalloff(Math.hypot(px, py), radius, 0.2) * strength;
      if (wt <= 0) continue;
      weight[y * w + x] = wt;
      const sx = cx + (ca * px - sa * py) / zoom;
      const sy = cy + (sa * px + ca * py) / zoom;
      sampleBilinear(src, sx, sy, tmp);
      const k = (y * w + x) * 4;
      img.data[k] = tmp[0] as number;
      img.data[k + 1] = tmp[1] as number;
      img.data[k + 2] = tmp[2] as number;
      img.data[k + 3] = tmp[3] as number;
    }
  }
  return { img, weight };
}

export function createFeedback(): AsyncLabTool {
  const q = new Serial();
  let rs = new Resampler(4);
  let local: LocalCanvas | null = null;

  const dabs = (ctx: LabContext, samples: Sample[]) => {
    const radius = strokeRadius(ctx);
    const zoom = num(ctx.params, "zoom", 1.05);
    const rot = num(ctx.params, "rotation", 4);
    const strength = num(ctx.params, "strength", 0.6);
    const canvas = local;
    if (!canvas) return;
    for (const s of samples) {
      q.run(async () => {
        const r = radius * clamp(0.3 + 0.7 * s.pressure, 0.3, 1);
        const side = Math.ceil(r * 2) + 2;
        const rect: Rect = { x: Math.round(s.x - side / 2), y: Math.round(s.y - side / 2), w: side, h: side };
        await canvas.ensure(rect);
        const src = canvas.read(rect);
        const { img, weight } = feedbackDab(src, r, zoom, rot, strength);
        canvas.write(rect, img, weight);
        const mask = makeImage(rect.w, rect.h);
        for (let i = 0; i < weight.length; i++) {
          mask.data.fill(255, i * 4, i * 4 + 3);
          mask.data[i * 4 + 3] = Math.round((weight[i] as number) * 255);
        }
        ctx.composite(img, rect, mask);
      });
    }
  };

  return {
    id: "feedback",
    label: "Feedback",
    description: "Each dab zooms and twists the picture into itself, making tunnels and echoes.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "Like pointing a camera at its own screen: each dab copies the pixels under it, magnifies them a little and turns them a little, and puts them back. The next dab then copies the result, so the change compounds along your stroke into a spiral or tunnel. Nothing is random.",
    },
    params: PARAMS,
    icon: "feedback",
    onStrokeBegin(ctx, p) {
      rs = new Resampler(Math.max(2, strokeRadius(ctx) * 0.3));
      local = new LocalCanvas(ctx);
      rs.begin(p);
    },
    onStrokeExtend(ctx, points) {
      dabs(ctx, rs.push(points));
    },
    onStrokeEnd(ctx) {
      dabs(ctx, rs.finish());
    },
    flush: () => q.flush(),
  };
}
