// Particles: each dab emits particles with gravity, wind, drag and a lifetime;
// they draw their trails tick by tick in step().

import type { InputPoint } from "../engine/types";
import { num, Resampler, str, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import { ext } from "./ext";
import type { LabContext, LabParam } from "./types";

interface Physics {
  /** Emission direction, degrees (0 right, 90 down). */
  angle: number;
  /** Cone width, degrees. */
  spread: number;
  speed: number;
  gravity: number;
  drag: number;
  life: number;
  /** Trail drawn per tick as a multiple of the tick's travel. */
  trail: number;
}

export const PRESETS: Record<string, Physics> = {
  sparks: { angle: -90, spread: 140, speed: 6, gravity: 0.18, drag: 0.03, life: 38, trail: 1 },
  dust: { angle: -90, spread: 360, speed: 1.4, gravity: -0.01, drag: 0.06, life: 90, trail: 1 },
  rain: { angle: 100, spread: 6, speed: 9, gravity: 0.35, drag: 0, life: 45, trail: 3 },
};

const PARAMS: LabParam[] = [
  {
    id: "preset",
    label: "Preset",
    type: "choice",
    choices: [
      { value: "sparks", label: "Sparks" },
      { value: "dust", label: "Dust" },
      { value: "rain", label: "Rain streaks" },
      { value: "custom", label: "Custom" },
    ],
    default: "sparks",
    tip: "A starting physics. Custom uses the sliders below instead; Wind and Amount always apply.",
  },
  { id: "count", label: "Amount", type: "number", min: 1, max: 20, step: 1, default: 4, tip: "Particles released at each dab." },
  { id: "wind", label: "Wind", type: "number", min: -1, max: 1, step: 0.05, default: 0, tip: "Sideways push per tick. Negative blows left." },
  { id: "gravity", label: "Gravity", type: "number", min: -0.5, max: 1, step: 0.01, default: 0.15, tip: "Downward pull per tick (Custom only). Negative floats up." },
  { id: "drag", label: "Drag", type: "number", min: 0, max: 0.2, step: 0.005, default: 0.02, tip: "Air resistance: how fast particles slow down (Custom only)." },
  { id: "lifetime", label: "Lifetime", type: "number", min: 5, max: 200, step: 1, default: 40, tip: "How many ticks a particle lives (Custom only)." },
  { id: "spread", label: "Spread", type: "number", min: 0, max: 360, step: 5, default: 120, tip: "Width of the cone particles leave in, in degrees (Custom only)." },
  { id: "speed", label: "Speed", type: "number", min: 0.2, max: 15, step: 0.1, default: 5, tip: "Launch speed in pixels per tick (Custom only)." },
  { id: "ticks", label: "Duration", type: "number", min: 5, max: 400, step: 5, default: 120, tip: "The most ticks the animation runs before it stops by itself." },
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  pressure: number;
}

export function physicsOf(params: LabContext["params"]): Physics {
  const preset = str(params, "preset", "sparks");
  const known = PRESETS[preset];
  if (known) return known;
  return {
    angle: -90,
    spread: num(params, "spread", 120),
    speed: num(params, "speed", 5),
    gravity: num(params, "gravity", 0.15),
    drag: num(params, "drag", 0.02),
    life: num(params, "lifetime", 40),
    trail: 1,
  };
}

export function createParticles(): AsyncLabTool {
  let rs = new Resampler(6);
  let live: Particle[] = [];

  const emit = (ctx: LabContext, samples: Sample[]) => {
    const phys = physicsOf(ctx.params);
    const n = Math.round(num(ctx.params, "count", 4));
    for (const s of samples) {
      const r = ctx.rng(`particles:${s.index}`);
      for (let i = 0; i < n; i++) {
        const a = ((phys.angle + (r() - 0.5) * phys.spread) * Math.PI) / 180;
        const sp = phys.speed * (0.5 + r());
        live.push({ x: s.x, y: s.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: Math.max(2, Math.round(phys.life * (0.6 + 0.4 * r()))), pressure: s.pressure });
      }
    }
  };

  const mk = (x: number, y: number, pressure: number): InputPoint => ({ x, y, pressure: Math.max(0.05, Math.min(1, pressure)), tiltX: 0, tiltY: 0, twist: 0, t: 0, pointer: "pen" });

  return {
    id: "particles",
    label: "Particles",
    description: "Every dab throws off sparks, dust or rain streaks that draw their own trails.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: {
      kind: "algorithm",
      text: "Each dab releases a few particles in a random direction inside a cone. Every tick, gravity and wind change a particle's speed, drag slows it, and it moves. It paints a short line from where it was to where it is, thinner as it ages, until its lifetime runs out. The same seed releases the same particles.",
    },
    params: PARAMS,
    icon: "particles",
    onStrokeBegin(_ctx, p) {
      rs = new Resampler(6);
      live = [];
      rs.begin(p);
    },
    onStrokeExtend(ctx, points) {
      emit(ctx, rs.push(points));
    },
    onStrokeEnd(ctx) {
      emit(ctx, rs.finish());
    },
    step(ctx, tick) {
      const phys = physicsOf(ctx.params);
      const wind = num(ctx.params, "wind", 0) * 0.3;
      const maxTicks = Math.round(num(ctx.params, "ticks", 120));
      const next: Particle[] = [];
      for (const q of live) {
        const x0 = q.x;
        const y0 = q.y;
        q.vx = (q.vx + wind) * (1 - phys.drag);
        q.vy = (q.vy + phys.gravity) * (1 - phys.drag);
        q.x += q.vx;
        q.y += q.vy;
        q.age++;
        const fade = 1 - q.age / q.life;
        // A streak (rain) draws a tail behind the head; others draw the tick's travel.
        const tx = phys.trail > 1 ? q.x - q.vx * phys.trail : x0;
        const ty = phys.trail > 1 ? q.y - q.vy * phys.trail : y0;
        const n = Math.max(1, Math.ceil(Math.hypot(q.x - tx, q.y - ty) / 2));
        const pts: InputPoint[] = [];
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          pts.push(mk(tx + (q.x - tx) * f, ty + (q.y - ty) * f, q.pressure * fade));
        }
        const x = ext(ctx);
        if (x.dabAs) x.dabAs(pts, { sizeScale: 0.5, opacity: Math.max(0.1, fade) });
        else ctx.dab(pts);
        if (q.age < q.life) next.push(q);
      }
      live = next;
      return live.length > 0 && tick + 1 < maxTicks;
    },
    flush: () => Promise.resolve(),
  };
}
