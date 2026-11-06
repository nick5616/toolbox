// Voronoi crackle: seeded cells inside the painted area, as cracks, stained
// glass or dry mud. The cell seeds depend only on canvas position and the seed.

import type { InputPoint, Rect } from "../engine/types";
import { clamp, colorBytes, currentColor, hash2, makeImage, maskFromCoverage, num, pointsBounds, present, rasterizeStroke, Serial, smoothstep, str, strokeHardness, strokeRadius } from "./common";
import type { AsyncLabTool } from "./ext";
import type { LabContext, LabParam } from "./types";

const PARAMS: LabParam[] = [
  {
    id: "mode",
    label: "Look",
    type: "choice",
    choices: [
      { value: "cracks", label: "Cracks" },
      { value: "glass", label: "Stained glass" },
      { value: "mud", label: "Dry mud" },
    ],
    default: "cracks",
    tip: "Cracks draw thin lines in your colour, stained glass fills each cell with the colour under it, dry mud fills cells and darkens their edges.",
  },
  { id: "cell", label: "Cell size", type: "number", min: 8, max: 160, step: 2, default: 36, tip: "Average width of a cell in pixels." },
  { id: "width", label: "Line width", type: "number", min: 0.5, max: 12, step: 0.5, default: 2.5, tip: "Thickness of the cracks or lead lines in pixels." },
  { id: "irregularity", label: "Irregularity", type: "number", min: 0, max: 1, step: 0.05, default: 0.8, tip: "0 makes an even grid of cells; 1 makes uneven, natural ones." },
];

export interface VoronoiOptions {
  cell: number;
  irregularity: number;
  salt: number;
}

/** Seed point of lattice cell (i, j). */
export function seedPoint(i: number, j: number, o: VoronoiOptions): [number, number] {
  const jit = 0.5 + (hash2(i, j, o.salt) - 0.5) * o.irregularity * 0.9;
  const jit2 = 0.5 + (hash2(i, j, o.salt + 7) - 0.5) * o.irregularity * 0.9;
  return [(i + jit) * o.cell, (j + jit2) * o.cell];
}

export interface Hit {
  /** Lattice cell of the nearest seed. */
  ci: number;
  cj: number;
  /** Approximate distance to the nearest cell border, px. */
  edge: number;
}

export function nearest(x: number, y: number, o: VoronoiOptions): Hit {
  const bi = Math.floor(x / o.cell);
  const bj = Math.floor(y / o.cell);
  let d1 = Infinity;
  let d2 = Infinity;
  let ci = 0;
  let cj = 0;
  for (let j = bj - 1; j <= bj + 1; j++) {
    for (let i = bi - 1; i <= bi + 1; i++) {
      const [sx, sy] = seedPoint(i, j, o);
      const d = Math.hypot(x - sx, y - sy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        ci = i;
        cj = j;
      } else if (d < d2) d2 = d;
    }
  }
  return { ci, cj, edge: (d2 - d1) / 2 };
}

export function renderVoronoi(
  mode: string,
  rect: Rect,
  snapshot: ImageData | null,
  color: [number, number, number],
  o: VoronoiOptions,
  lineWidth: number,
): ImageData {
  const img = makeImage(rect.w, rect.h);
  const hits: Hit[] = new Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) hits[y * rect.w + x] = nearest(rect.x + x + 0.5, rect.y + y + 0.5, o);
  // Stained glass: average colour of each cell (premultiplied by alpha) over the area.
  const avg = new Map<string, [number, number, number, number, number]>();
  if (mode === "glass" && snapshot) {
    for (let i = 0; i < hits.length; i++) {
      const hh = hits[i] as Hit;
      const key = `${hh.ci},${hh.cj}`;
      let a = avg.get(key);
      if (!a) {
        a = [0, 0, 0, 0, 0];
        avg.set(key, a);
      }
      const al = (snapshot.data[i * 4 + 3] as number) / 255;
      a[0] += (snapshot.data[i * 4] as number) * al;
      a[1] += (snapshot.data[i * 4 + 1] as number) * al;
      a[2] += (snapshot.data[i * 4 + 2] as number) * al;
      a[3] += al;
      a[4]++;
    }
  }
  for (let i = 0; i < hits.length; i++) {
    const hh = hits[i] as Hit;
    const line = 1 - smoothstep(lineWidth * 0.35, lineWidth * 0.5 + 0.5, hh.edge);
    const k = i * 4;
    if (mode === "cracks") {
      img.data[k] = color[0];
      img.data[k + 1] = color[1];
      img.data[k + 2] = color[2];
      img.data[k + 3] = Math.round(line * 255);
    } else if (mode === "glass") {
      const a = avg.get(`${hh.ci},${hh.cj}`);
      const n = a && a[3] > 0 ? a[3] : 1;
      const c = a && a[3] > 0 ? [a[0] / n, a[1] / n, a[2] / n] : color;
      const lead = line;
      img.data[k] = (c[0] as number) * (1 - lead) + 25 * lead;
      img.data[k + 1] = (c[1] as number) * (1 - lead) + 25 * lead;
      img.data[k + 2] = (c[2] as number) * (1 - lead) + 25 * lead;
      img.data[k + 3] = 255;
    } else {
      // mud: each cell a slightly different shade of the colour, dark toward its border
      const shade = 0.82 + 0.3 * hash2(hh.ci, hh.cj, o.salt + 31);
      const dark = 1 - 0.75 * (1 - smoothstep(0, lineWidth * 2.2 + 1, hh.edge));
      for (let c = 0; c < 3; c++) img.data[k + c] = clamp(color[c] as number, 0, 255) * shade * dark;
      img.data[k + 3] = 255;
    }
  }
  return img;
}

export function createVoronoi(): AsyncLabTool {
  const q = new Serial();
  let pts: InputPoint[] = [];

  const finish = (ctx: LabContext) => {
    const points = pts.slice();
    q.run(async () => {
      const radius = strokeRadius(ctx);
      const rect = pointsBounds(points, radius + 1);
      const o: VoronoiOptions = {
        cell: num(ctx.params, "cell", 36),
        irregularity: num(ctx.params, "irregularity", 0.8),
        salt: Math.floor(ctx.rng("voronoi:salt")() * 1e9),
      };
      const mode = str(ctx.params, "mode", "cracks");
      const snap = mode === "glass" ? await ctx.snapshot(rect) : null;
      const img = renderVoronoi(mode, rect, snap, colorBytes(currentColor(ctx)), o, num(ctx.params, "width", 2.5));
      const cov = rasterizeStroke(points, radius, strokeHardness(ctx), rect, 1);
      present(ctx, rect, img, maskFromCoverage(cov.data, cov.w, cov.h), true);
    });
  };

  return {
    id: "voronoi-crackle",
    label: "Voronoi crackle",
    description: "Breaks the painted area into cells, like glaze cracks, stained glass or dry mud.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: {
      kind: "algorithm",
      text: "A Voronoi diagram scatters seed points and gives every spot on the canvas to its nearest seed, which cuts the area into cells whose borders sit halfway between neighbouring seeds. The seeds come from a jittered grid chosen by the seed number, so the same seed always cracks the same way. Cracks draw the borders, stained glass fills each cell with the average colour under it, and dry mud shades cells and darkens their borders.",
    },
    params: PARAMS,
    icon: "voronoi",
    onStrokeBegin(_ctx, p) {
      pts = [p];
    },
    onStrokeExtend(_ctx, points) {
      pts.push(...points);
    },
    onStrokeEnd(ctx) {
      finish(ctx);
    },
    flush: () => q.flush(),
  };
}
