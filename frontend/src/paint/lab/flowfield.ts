// Flow field: curl noise drives a bundle of hair strands seeded along the stroke.

import type { InputPoint } from "../engine/types";
import { curl, num, Resampler, strokeRadius, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  { id: "scale", label: "Scale", type: "number", min: 20, max: 400, step: 5, default: 120, tip: "How big the swirls are, in pixels. Small values curl tightly; large ones drift." },
  { id: "turbulence", label: "Turbulence", type: "number", min: 0, max: 1, step: 0.05, default: 0.6, tip: "How strongly the field bends the hairs away from your stroke direction." },
  { id: "evolution", label: "Evolution", type: "number", min: 0, max: 1, step: 0.05, default: 0.3, tip: "How fast the field changes along your stroke, so hairs further along curl differently." },
  { id: "strands", label: "Strands", type: "number", min: 1, max: 24, step: 1, default: 8, tip: "How many hairs each sweep of the bundle lays down." },
  { id: "length", label: "Length", type: "number", min: 10, max: 300, step: 5, default: 80, tip: "How far each hair runs, in pixels." },
  { id: "spread", label: "Spread", type: "number", min: 0, max: 3, step: 0.1, default: 1, tip: "Width of the bundle as a multiple of the brush size." },
];

export function createFlowField(): AsyncLabTool {
  let rs = new Resampler(10);
  let salt = 1;

  const strand = (ctx: LabContext, s: Sample, i: number, n: number, r: () => number): InputPoint[] => {
    const p = ctx.params;
    const scale = num(p, "scale", 120);
    const turb = num(p, "turbulence", 0.6);
    const evo = num(p, "evolution", 0.3);
    const length = num(p, "length", 80);
    const spread = num(p, "spread", 1);
    const radius = strokeRadius(ctx);
    const off = ((i + 0.5) / n - 0.5) * 2 * radius * spread + (r() - 0.5) * radius * 0.2;
    let x = s.x - s.ty * off;
    let y = s.y + s.tx * off;
    let dx = s.tx;
    let dy = s.ty;
    const stepLen = 2;
    const steps = Math.max(2, Math.round(length / stepLen));
    const z = (s.dist / scale) * evo * 2;
    const pts: InputPoint[] = [];
    for (let k = 0; k < steps; k++) {
      const taper = 1 - k / steps;
      pts.push({ x, y, pressure: Math.max(0.05, s.pressure * (0.2 + 0.8 * taper)), tiltX: 0, tiltY: 0, twist: 0, t: s.t, pointer: "pen" });
      const [cx, cy] = curl(x / scale + z, y / scale - z * 0.7, salt);
      const cl = Math.hypot(cx, cy) || 1;
      // Blend the stroke's direction with the field, then keep the heading smooth.
      const fx = s.tx * (1 - turb) + (cx / cl) * turb;
      const fy = s.ty * (1 - turb) + (cy / cl) * turb;
      dx = dx * 0.7 + fx * 0.3;
      dy = dy * 0.7 + fy * 0.3;
      const dl = Math.hypot(dx, dy) || 1;
      x += (dx / dl) * stepLen;
      y += (dy / dl) * stepLen;
    }
    return pts;
  };

  const emit = (ctx: LabContext, samples: Sample[]) => {
    const n = Math.round(num(ctx.params, "strands", 8));
    for (const s of samples) {
      const r = ctx.rng(`flow:${s.index}`);
      for (let i = 0; i < n; i++) ctx.dab(strand(ctx, s, i, n, r));
    }
  };

  return {
    id: "flow-field",
    label: "Flow field",
    description: "A straight stroke becomes a swirling bundle of hairs that follow a curl-noise field.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: {
      kind: "algorithm",
      text: "Curl noise is a smooth random field turned 90 degrees, so it never bunches up or fans out. Every few pixels along your stroke the tool lays down a handful of hairs side by side. Each hair walks forward in small steps, steering between your stroke direction and the field, and thins out toward its tip. The same seed gives the same hairs.",
    },
    params: PARAMS,
    icon: "flow-field",
    onStrokeBegin(ctx, p) {
      const length = num(ctx.params, "length", 80);
      rs = new Resampler(Math.max(3, length * 0.25));
      salt = Math.floor(ctx.rng("flow:salt")() * 1e6);
      rs.begin(p);
    },
    onStrokeExtend(ctx, points) {
      emit(ctx, rs.push(points));
    },
    onStrokeEnd(ctx) {
      emit(ctx, rs.finish());
    },
    flush: () => Promise.resolve(),
  };
}
