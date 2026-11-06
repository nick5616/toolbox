// Echo trail: repeats the stroke as fading offset copies.

import type { InputPoint } from "../engine/types";
import { num } from "./common";
import type { AsyncLabTool } from "./ext";
import { ext } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  { id: "count", label: "Copies", type: "number", min: 1, max: 16, step: 1, default: 5, tip: "How many echoes follow your stroke." },
  { id: "offset", label: "Offset", type: "number", min: 2, max: 120, step: 1, default: 24, tip: "Distance between one copy and the next, in pixels." },
  { id: "angle", label: "Direction", type: "number", min: -180, max: 180, step: 5, default: 90, tip: "Where the echoes drift, in degrees. 0 is right, 90 is down." },
  { id: "fade", label: "Fade", type: "number", min: 0, max: 1, step: 0.05, default: 0.25, tip: "How much fainter each copy gets than the one before." },
  { id: "shrink", label: "Shrink", type: "number", min: 0, max: 0.5, step: 0.02, default: 0.06, tip: "How much smaller each copy gets, as a fraction of its size." },
];

export function createEcho(): AsyncLabTool {
  const draw = (ctx: LabContext, pts: InputPoint[]) => {
    if (!pts.length) return;
    const p = ctx.params;
    const count = Math.round(num(p, "count", 5));
    const offset = num(p, "offset", 24);
    const a = (num(p, "angle", 90) * Math.PI) / 180;
    const fade = num(p, "fade", 0.25);
    const shrink = num(p, "shrink", 0.06);
    const dx = Math.cos(a) * offset;
    const dy = Math.sin(a) * offset;
    const x = ext(ctx);
    // Furthest copy first, so nearer (stronger) copies draw on top.
    for (let i = count; i >= 0; i--) {
      const moved = pts.map((q) => ({ ...q, x: q.x + dx * i, y: q.y + dy * i }));
      if (x.dabAs) x.dabAs(moved, { opacity: Math.pow(1 - fade, i), sizeScale: Math.max(0.1, 1 - shrink * i) });
      else ctx.dab(moved);
    }
  };

  return {
    id: "echo-trail",
    label: "Echo trail",
    description: "Repeats your stroke as a row of fading, shrinking copies.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "Each point you paint is drawn again several times, shifted a fixed distance in a fixed direction. Every copy is a little fainter and smaller than the one before. Nothing is random: the same stroke always leaves the same echoes.",
    },
    params: PARAMS,
    icon: "echo-trail",
    onStrokeBegin(ctx, p) {
      draw(ctx, [p]);
    },
    onStrokeExtend(ctx, points) {
      draw(ctx, points);
    },
    onStrokeEnd() {},
    flush: () => Promise.resolve(),
  };
}
