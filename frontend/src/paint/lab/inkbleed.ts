// Ink bleed: wet ink spreads along the paper grain (a capillary simulation),
// then dries. The grain is a fixed noise, so the tool is Exact.

import type { InputPoint } from "../engine/types";
import { clamp, fbm, num } from "./common";
import type { AsyncLabTool } from "./ext";
import { buildArea, drawField, type SimArea } from "./sim";
import type { LabContext, LabParam } from "./types";

const GRAIN_SALT = 4242;

const PARAMS: LabParam[] = [
  { id: "reach", label: "Reach", type: "number", min: 2, max: 60, step: 1, default: 16, tip: "How far the ink can creep beyond your stroke, in pixels." },
  { id: "grain", label: "Grain size", type: "number", min: 1, max: 20, step: 0.5, default: 5, tip: "Size of the paper's fibres in pixels. Small is fine paper, large is rough." },
  { id: "wetness", label: "Wetness", type: "number", min: 0.1, max: 1, step: 0.05, default: 0.6, tip: "How freely ink flows. Wet paper bleeds further." },
  { id: "drying", label: "Drying", type: "number", min: 0.005, max: 0.15, step: 0.005, default: 0.03, tip: "How fast the paper dries. Fast drying stops the bleed sooner." },
  { id: "darkness", label: "Darkness", type: "number", min: 0.5, max: 4, step: 0.1, default: 1.8, tip: "How opaque the spread ink looks. Raise it as ink thins out." },
  { id: "ticks", label: "Duration", type: "number", min: 10, max: 400, step: 5, default: 150, tip: "The most ticks the ink bleeds before it stops by itself." },
];

class Ink {
  ink: Float32Array;
  wet: Float32Array;
  private ink2: Float32Array;
  readonly perm: Float32Array;
  constructor(readonly area: SimArea, grainPx: number) {
    const n = area.gw * area.gh;
    this.ink = Float32Array.from(area.cover);
    this.ink2 = new Float32Array(n);
    this.wet = Float32Array.from(area.cover, (c) => (c > 0 ? 1 : 0.9));
    this.perm = new Float32Array(n);
    for (let y = 0; y < area.gh; y++) {
      for (let x = 0; x < area.gw; x++) {
        const cx = ((x + 0.5) * area.scale + area.rect.x) / grainPx;
        const cy = ((y + 0.5) * area.scale + area.rect.y) / grainPx;
        // Fibres: stretched noise gives paper-like streaks, anchored to canvas coordinates.
        this.perm[y * area.gw + x] = 0.25 + 0.75 * fbm(cx, cy * 0.7, GRAIN_SALT);
      }
    }
  }

  iterate(flow: number, dry: number): void {
    const { gw, gh } = this.area;
    const { ink, ink2, wet, perm } = this;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        let acc = 0;
        const c = ink[i] as number;
        const link = (j: number) => {
          const k = Math.sqrt((perm[i] as number) * (perm[j] as number)) * Math.min(wet[i] as number, wet[j] as number);
          acc += flow * k * ((ink[j] as number) - c);
        };
        if (x > 0) link(i - 1);
        if (x < gw - 1) link(i + 1);
        if (y > 0) link(i - gw);
        if (y < gh - 1) link(i + gw);
        ink2[i] = c + acc;
      }
    }
    for (let i = 0; i < ink.length; i++) {
      ink[i] = ink2[i] as number;
      wet[i] = (wet[i] as number) * (1 - dry);
    }
  }

  wetness(): number {
    let m = 0;
    for (let i = 0; i < this.wet.length; i++) if ((this.wet[i] as number) > m) m = this.wet[i] as number;
    return m;
  }
}

export function createInkBleed(): AsyncLabTool {
  let pts: InputPoint[] = [];
  let sim: Ink | null = null;

  const show = (ctx: LabContext, final: boolean) => {
    if (!sim) return;
    const dark = num(ctx.params, "darkness", 1.8);
    const perm = sim.perm;
    const { gw } = sim.area;
    drawField(ctx, sim.area, sim.ink, (v, x, y) => {
      const p = perm[Math.min(sim!.area.gh - 1, Math.floor(y)) * gw + Math.min(gw - 1, Math.floor(x))] as number;
      return clamp(v * dark, 0, 1) * (0.78 + 0.22 * p);
    }, final);
  };

  return {
    id: "ink-bleed",
    label: "Ink bleed",
    description: "Wet ink creeps along the paper's grain, then dries where it stopped.",
    kind: "algorithmic",
    predictability: "exact",
    origin: {
      kind: "algorithm",
      text: "The paper is a grid of fibre densities from a fixed noise pattern. Ink moves between neighbouring cells in proportion to how open both cells are and how wet they are, so it runs along loose fibres and stalls on tight ones. Each tick the paper dries a little, and when it is dry the ink stops. No random numbers are involved: the same stroke always bleeds the same way.",
    },
    params: PARAMS,
    icon: "ink-bleed",
    onStrokeBegin(_ctx, p) {
      pts = [p];
      sim = null;
    },
    onStrokeExtend(_ctx, points) {
      pts.push(...points);
    },
    onStrokeEnd(ctx) {
      const reach = num(ctx.params, "reach", 16);
      sim = new Ink(buildArea(ctx, pts, reach), num(ctx.params, "grain", 5));
    },
    step(ctx, tick) {
      if (!sim) return false;
      const flow = 0.24 * num(ctx.params, "wetness", 0.6) * 1.6;
      const dry = num(ctx.params, "drying", 0.03);
      for (let i = 0; i < 2; i++) sim.iterate(Math.min(flow, 0.24), dry);
      const settled = tick + 1 >= Math.round(num(ctx.params, "ticks", 150)) || sim.wetness() < 0.02;
      show(ctx, settled);
      if (settled) sim = null;
      return !settled;
    },
    flush: () => Promise.resolve(),
  };
}
