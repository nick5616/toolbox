// Reaction-diffusion (Gray-Scott): the painted area seeds a chemical V, and
// patterns grow in it over a number of fixed ticks. Exact: no seed involved.

import type { InputPoint } from "../engine/types";
import { hash2, num, smoothstep, str } from "./common";
import type { AsyncLabTool } from "./ext";
import { buildArea, drawField, type SimArea } from "./sim";
import type { LabContext, LabParam } from "./types";

/** Feed (F) and kill (k) rates. */
export const RD_PRESETS: Record<string, { f: number; k: number }> = {
  coral: { f: 0.0545, k: 0.062 },
  maze: { f: 0.029, k: 0.057 },
  spots: { f: 0.0367, k: 0.0649 },
  fingerprints: { f: 0.037, k: 0.06 },
};

const PARAMS: LabParam[] = [
  {
    id: "preset",
    label: "Pattern",
    type: "choice",
    choices: [
      { value: "coral", label: "Coral" },
      { value: "maze", label: "Maze" },
      { value: "spots", label: "Spots" },
      { value: "fingerprints", label: "Fingerprints" },
    ],
    default: "coral",
    tip: "The kind of pattern that grows. Each is a different pair of feed and kill rates.",
  },
  { id: "ticks", label: "Duration", type: "number", min: 10, max: 400, step: 5, default: 90, tip: "How many ticks the pattern grows before it settles. Longer gives finer detail." },
  { id: "speed", label: "Speed", type: "number", min: 1, max: 40, step: 1, default: 12, tip: "Simulation steps per tick. Higher grows faster but costs more per tick." },
  { id: "contrast", label: "Contrast", type: "number", min: 0.5, max: 3, step: 0.1, default: 1.4, tip: "How crisply the pattern separates ink from background." },
];

const DU = 1.0;
const DV = 0.5;

class Sim {
  u: Float32Array;
  v: Float32Array;
  private u2: Float32Array;
  private v2: Float32Array;
  readonly confine: Float32Array;
  constructor(readonly area: SimArea, readonly f: number, readonly k: number) {
    const n = area.gw * area.gh;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.u2 = new Float32Array(n);
    this.v2 = new Float32Array(n);
    for (let y = 0; y < area.gh; y++) {
      for (let x = 0; x < area.gw; x++) {
        const i = y * area.gw + x;
        const c = area.cover[i] as number;
        this.u[i] = 1 - 0.5 * c;
        this.v[i] = c > 0.2 ? 0.25 * (0.6 + 0.8 * hash2(x, y, 17)) : 0;
      }
    }
    // Patterns may not grow beyond a softened copy of the painted area.
    let c = area.cover;
    for (let pass = 0; pass < 3; pass++) c = blur3(c, area.gw, area.gh);
    this.confine = c.map((q) => Math.min(1, q * 3));
  }

  /** One step; returns the largest change in V. */
  iterate(): number {
    const { gw, gh } = this.area;
    const { u, v, u2, v2, f, k, confine } = this;
    let maxd = 0;
    for (let y = 0; y < gh; y++) {
      const ym = y > 0 ? y - 1 : y;
      const yp = y < gh - 1 ? y + 1 : y;
      for (let x = 0; x < gw; x++) {
        const xm = x > 0 ? x - 1 : x;
        const xp = x < gw - 1 ? x + 1 : x;
        const i = y * gw + x;
        const lu =
          0.2 * ((u[y * gw + xm] as number) + (u[y * gw + xp] as number) + (u[ym * gw + x] as number) + (u[yp * gw + x] as number)) +
          0.05 * ((u[ym * gw + xm] as number) + (u[ym * gw + xp] as number) + (u[yp * gw + xm] as number) + (u[yp * gw + xp] as number)) -
          (u[i] as number);
        const lv =
          0.2 * ((v[y * gw + xm] as number) + (v[y * gw + xp] as number) + (v[ym * gw + x] as number) + (v[yp * gw + x] as number)) +
          0.05 * ((v[ym * gw + xm] as number) + (v[ym * gw + xp] as number) + (v[yp * gw + xm] as number) + (v[yp * gw + xp] as number)) -
          (v[i] as number);
        const a = u[i] as number;
        const b = v[i] as number;
        const r = a * b * b;
        const nu = a + DU * lu - r + f * (1 - a);
        let nv = b + DV * lv + r - (k + f) * b;
        nv *= confine[i] as number;
        u2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
        v2[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
        const d = Math.abs((v2[i] as number) - b);
        if (d > maxd) maxd = d;
      }
    }
    this.u = u2;
    this.v = v2;
    this.u2 = u;
    this.v2 = v;
    return maxd;
  }
}

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          const yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx] as number;
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

export function createReactionDiffusion(): AsyncLabTool {
  let pts: InputPoint[] = [];
  let sim: Sim | null = null;

  const show = (ctx: LabContext, final: boolean) => {
    if (!sim) return;
    const contrast = num(ctx.params, "contrast", 1.4);
    drawField(ctx, sim.area, sim.v, (v) => smoothstep(0.08, 0.08 + 0.2 / contrast, v), final);
  };

  return {
    id: "reaction-diffusion",
    label: "Reaction-diffusion",
    description: "Paint a seed, then watch coral, maze, spot or fingerprint patterns grow inside it. Stop it when you like.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "Gray-Scott is a model of two chemicals on a grid. Chemical U is food and V eats it; V spreads slowly and dies off, U spreads quickly and is topped up. Where they meet, V can build stripes, spots or branches depending on two rates. Your stroke plants the first V, and the pattern grows inside it step by step. It uses no random numbers and no training data, so the same stroke always grows the same pattern.",
    },
    params: PARAMS,
    icon: "reaction-diffusion",
    onStrokeBegin(_ctx, p) {
      pts = [p];
      sim = null;
    },
    onStrokeExtend(_ctx, points) {
      pts.push(...points);
    },
    onStrokeEnd(ctx) {
      const preset = RD_PRESETS[str(ctx.params, "preset", "coral")] ?? (RD_PRESETS.coral as { f: number; k: number });
      sim = new Sim(buildArea(ctx, pts, 4), preset.f, preset.k);
    },
    step(ctx, tick) {
      if (!sim) return false;
      const maxTicks = Math.round(num(ctx.params, "ticks", 90));
      const per = Math.round(num(ctx.params, "speed", 12));
      let change = 0;
      for (let i = 0; i < per; i++) change = sim.iterate();
      const settled = tick + 1 >= maxTicks || change < 1e-5;
      show(ctx, settled);
      if (settled) sim = null;
      return !settled;
    },
    flush: () => Promise.resolve(),
  };
}
