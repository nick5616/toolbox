/**
 * Ripples (SPEC.md §6.7 #24): luminous rings that expand and thin out from an
 * origin on events. The trigger picks the event source; the rings of an event
 * are staggered echoes. Each ring is a closed form of its age.
 */
import { QuadBatch, SHADE_RING } from "../gl/quads";
import { COLOR_OPTIONS, lerp, pickColor, rnd, smoothstep } from "./_particles";
import { TRIGGER_OPTIONS, eventsIn, triggerList } from "./_triggers";
import { registerLayer } from "./registry";

registerLayer({
  type: "ripples",
  label: "Ripples",
  group: "accent",
  icon: "circle-dot",
  params: {
    trigger: { kind: "enum", label: "Trigger", options: TRIGGER_OPTIONS, default: "kick" },
    every: { kind: "number", label: "Every nth event", min: 1, max: 8, default: 1, step: 1 },
    maxRadius: { kind: "number", label: "Reach", min: 0.1, max: 1.5, default: 0.85 },
    width: { kind: "number", label: "Line width", min: 0.002, max: 0.06, default: 0.008 },
    life: { kind: "number", label: "Lifetime (s)", min: 0.6, max: 4, default: 1.7 },
    rings: { kind: "number", label: "Echoes", min: 1, max: 4, default: 2, step: 1 },
    x: { kind: "number", label: "Centre x", min: 0, max: 1, default: 0.5 },
    y: { kind: "number", label: "Centre y", min: 0, max: 1, default: 0.5 },
    scatter: { kind: "bool", label: "Random centres", default: false },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.6 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.4 },
    color: { kind: "enum", label: "Colour", options: COLOR_OPTIONS, default: "cycle" },
  },
  create(ctx) {
    const batch = new QuadBatch(ctx.gl, SHADE_RING, 128);
    return {
      render(f) {
        const life = f.params.life as number;
        const rings = Math.round(f.params.rings as number);
        const stagger = 0.13;
        const short = Math.min(f.w, f.h);
        const reach = (f.params.maxRadius as number) * short;
        const widthPx = (f.params.width as number) * short;
        const glowPx = (f.params.glow as number) * short * 0.012;
        const bright = f.params.brightness as number;
        const mode = f.params.color as string;
        const list = triggerList(f.analysis, f.params.trigger as string, Math.round(f.params.every as number));
        const evs = eventsIn(list, f.tMs - (life + stagger * rings) * 1000, f.tMs);
        batch.begin();
        const first = Math.max(0, evs.length - 24);
        for (let ei = first; ei < evs.length; ei++) {
          const ev = evs[ei];
          if (!ev) continue;
          const strength = 0.45 + 0.55 * (ev[1] / 255);
          const key = Math.round(ev[0]);
          const col = pickColor(f.palette, mode, rnd(f.seed, key, 1) * 4);
          let cx = f.w * (f.params.x as number);
          let cy = f.h * (1 - (f.params.y as number));
          if (f.params.scatter) {
            cx = f.w * lerp(0.15, 0.85, rnd(f.seed, key, 2));
            cy = f.h * lerp(0.2, 0.8, rnd(f.seed, key, 3));
          }
          for (let j = 0; j < rings; j++) {
            const age = (f.tMs - ev[0]) / 1000 - j * stagger;
            if (age < 0) continue;
            const q = age / life;
            if (q >= 1) continue;
            const ease = 1 - Math.pow(1 - q, 2.6);
            const radius = Math.max(2, reach * ease * (1 - 0.1 * j));
            const th = Math.max(1.2, widthPx * (1.5 - 1.0 * q) * (1 - 0.18 * j));
            const alpha = Math.pow(1 - q, 1.6) * smoothstep(0, 0.03, age) * strength * f.opacity * (1 - 0.22 * j);
            batch.push(cx, cy, radius, radius, col[0] * bright, col[1] * bright, col[2] * bright, alpha, 0, th);
          }
        }
        batch.draw(f.w, f.h, glowPx * 6 + 4, (p) => p.f1("u_glow", glowPx));
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
