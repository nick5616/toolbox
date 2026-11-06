// Growth: an L-system grows branches, twigs and leaves from the stroke as its spine.

import type { InputPoint, RGBA } from "../engine/types";
import { num, Resampler, str, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import { ext } from "./ext";
import type { LabContext, LabParam } from "./types";

/** Leaf tips come from the brush library (B1); "brush" uses the current tip. */
export const LEAF_TIPS = [
  { value: "brush", label: "Current brush" },
  { value: "lib:leaf-simple", label: "Simple leaf" },
  { value: "lib:leaf-oak", label: "Oak leaf" },
  { value: "lib:leaf-fern", label: "Fern frond" },
  { value: "lib:leaf-needle", label: "Needle" },
];

const hex = (r: number, g: number, b: number): RGBA => ({ r: (r / 255) ** 2.2, g: (g / 255) ** 2.2, b: (b / 255) ** 2.2, a: 1 });

export const SEASONS: Record<string, RGBA[]> = {
  spring: [hex(150, 205, 90), hex(190, 230, 120), hex(240, 170, 190), hex(120, 190, 100)],
  summer: [hex(40, 120, 50), hex(70, 150, 60), hex(30, 95, 55), hex(100, 165, 70)],
  autumn: [hex(200, 90, 30), hex(225, 150, 40), hex(170, 50, 30), hex(215, 190, 70)],
  winter: [hex(120, 125, 130), hex(150, 155, 160), hex(200, 210, 220), hex(95, 90, 90)],
};

const PARAMS: LabParam[] = [
  { id: "angle", label: "Branch angle", type: "number", min: 10, max: 80, step: 1, default: 35, tip: "How wide branches fork away from their parent, in degrees." },
  { id: "depth", label: "Depth", type: "number", min: 1, max: 6, step: 1, default: 4, tip: "How many times branches split into twigs. Higher is bushier and slower." },
  { id: "length", label: "Branch length", type: "number", min: 15, max: 200, step: 5, default: 60, tip: "Length of the first branches in pixels. Each generation is shorter." },
  { id: "leafDensity", label: "Leaf density", type: "number", min: 0, max: 1, step: 0.05, default: 0.6, tip: "How many twig ends and branch points grow a leaf." },
  {
    id: "season",
    label: "Season",
    type: "choice",
    choices: [
      { value: "spring", label: "Spring" },
      { value: "summer", label: "Summer" },
      { value: "autumn", label: "Autumn" },
      { value: "winter", label: "Winter" },
    ],
    default: "summer",
    tip: "Leaf colours. Winter leaves are sparse and grey.",
  },
  { id: "tip", label: "Leaf shape", type: "choice", choices: LEAF_TIPS, default: "brush", tip: "The brush tip used for leaves. The current brush works with any tip." },
];

const D2R = Math.PI / 180;

export function createGrowth(): AsyncLabTool {
  let rs = new Resampler(20);

  const pt = (x: number, y: number, pressure: number, t: number): InputPoint => ({ x, y, pressure: Math.max(0.05, Math.min(1, pressure)), tiltX: 0, tiltY: 0, twist: 0, t, pointer: "pen" });

  const grow = (ctx: LabContext, r: () => number, x: number, y: number, heading: number, len: number, depth: number, maxDepth: number, pressure: number, t: number) => {
    const p = ctx.params;
    const angle = num(p, "angle", 35) * D2R;
    const density = num(p, "leafDensity", 0.6);
    const season = str(p, "season", "summer");
    const tip = str(p, "tip", "brush");
    const palette = SEASONS[season] ?? (SEASONS.summer as RGBA[]);
    const segs = 6;
    const seg = len / segs;
    const pts: InputPoint[] = [pt(x, y, pressure, t)];
    let h = heading;
    const twigAt = 3;
    const branches: Array<[number, number, number]> = []; // x, y, heading for children
    for (let i = 1; i <= segs; i++) {
      h += (r() - 0.5) * 0.35;
      x += Math.cos(h) * seg;
      y += Math.sin(h) * seg;
      pts.push(pt(x, y, pressure * (1 - (i / segs) * 0.6), t));
      if (i === twigAt && depth > 1) branches.push([x, y, h + (r() < 0.5 ? -1 : 1) * angle * (0.8 + 0.4 * r())]);
    }
    ctx.dab(pts);
    const leaf = (lx: number, ly: number, lh: number) => {
      const winterScale = season === "winter" ? 0.08 : 1;
      if (r() > density * winterScale) return;
      const color = palette[Math.floor(r() * palette.length) % palette.length] as RGBA;
      const style = { tip: tip === "brush" ? undefined : tip, color, sizeScale: 0.7 + 0.8 * r(), angle: (lh / D2R + 90) % 360 };
      const pts1 = [pt(lx, ly, 0.7 + 0.3 * r(), t)];
      const x2 = ext(ctx);
      if (x2.dabAs) x2.dabAs(pts1, style);
      else ctx.dab(pts1);
    };
    if (depth > 1) {
      branches.push([x, y, h - angle * (0.7 + 0.6 * r())], [x, y, h + angle * (0.7 + 0.6 * r())]);
      for (const [bx, by, bh] of branches) grow(ctx, r, bx, by, bh, len * (0.62 + 0.15 * r()), depth - 1, maxDepth, pressure * 0.7, t);
      if (r() < 0.5) leaf(x, y, h);
    } else {
      leaf(x, y, h);
      leaf(x, y, h + (r() - 0.5));
    }
  };

  const emit = (ctx: LabContext, samples: Sample[]) => {
    const len = num(ctx.params, "length", 60);
    const depth = Math.round(num(ctx.params, "depth", 4));
    const angle = num(ctx.params, "angle", 35) * D2R;
    for (const s of samples) {
      const r = ctx.rng(`growth:${s.index}`);
      const spine = Math.atan2(s.ty, s.tx);
      // Branches leave the spine alternately to the left and right.
      const side = s.index % 2 === 0 ? -1 : 1;
      if (r() < 0.85) grow(ctx, r, s.x, s.y, spine + side * angle * (1.2 + 0.5 * r()), len * (0.8 + 0.4 * r()), depth, depth, s.pressure * 0.8, s.t);
    }
  };

  return {
    id: "growth",
    label: "Growth",
    description: "Branches, twigs and leaves grow from your stroke as if it were a vine.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: {
      kind: "algorithm",
      text: "An L-system is a rule that rewrites itself: a branch ends in two smaller branches, and each of those does the same. Your stroke is the spine. Every so often a branch leaves it at your chosen angle, forks a few times, and thins out. Twig ends and fork points may grow a leaf, drawn with a leaf tip in the colours of the season. The same seed grows the same plant.",
    },
    params: PARAMS,
    icon: "growth",
    onStrokeBegin(ctx, p) {
      const len = num(ctx.params, "length", 60);
      rs = new Resampler(Math.max(8, len * 0.45));
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
