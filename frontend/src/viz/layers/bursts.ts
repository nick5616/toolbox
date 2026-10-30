/**
 * Bursts (SPEC.md §6.7 #22): sparks fired from instrument onsets, one palette
 * colour per instrument, with streak trails and a quick shock ring at the
 * origin. Each burst is a pure function of its event (time, strength, seed) and
 * its age, with a damped velocity: v0·(1 − e^(−k·age))/k.
 */
import type { Event2 } from "../analysis";
import { SpriteBatch, PARTICLE_CAP, dampedDistance, lerp, pickColor, rnd, smoothstep } from "./_particles";
import { Sprite } from "./_sprites";
import { eventsIn, triggerList } from "./_triggers";
import { registerLayer } from "./registry";
import type { RGB } from "../palette";

const SOURCES = [
  { id: "kick", label: "Kick", color: "c0", scale: 1 },
  { id: "snare", label: "Snare", color: "c1", scale: 0.9 },
  { id: "hats", label: "Hi-hats", color: "accent", scale: 0.3 },
  { id: "bass", label: "Bass", color: "c2", scale: 0.8 },
  { id: "vocals", label: "Vocals", color: "c3", scale: 0.6 },
  { id: "other", label: "Other instruments", color: "glow", scale: 0.6 },
] as const;

interface Pending {
  t: number;
  strength: number;
  src: number;
}

registerLayer({
  type: "bursts",
  label: "Bursts",
  group: "particles",
  icon: "sparkles",
  params: {
    kick: { kind: "bool", label: "Kick", default: true },
    snare: { kind: "bool", label: "Snare", default: true },
    hats: { kind: "bool", label: "Hi-hats", default: false },
    bass: { kind: "bool", label: "Bass", default: false },
    vocals: { kind: "bool", label: "Vocals", default: true },
    other: { kind: "bool", label: "Other instruments", default: false },
    count: { kind: "number", label: "Per burst", min: 6, max: 60, default: 26, step: 1 },
    speed: { kind: "number", label: "Speed", min: 0.2, max: 2, default: 1 },
    spread: { kind: "number", label: "Spread", min: 0.1, max: 1, default: 1 },
    trail: { kind: "number", label: "Trails", min: 0, max: 1, default: 0.6 },
    gravity: { kind: "number", label: "Gravity", min: 0, max: 1, default: 0.35 },
    life: { kind: "number", label: "Lifetime (s)", min: 0.4, max: 3, default: 1.5 },
    size: { kind: "number", label: "Size", min: 0.4, max: 3, default: 1 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.6 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.8 },
    origin: { kind: "enum", label: "Origin", options: ["scatter", "center", "bottom", "sides"], default: "scatter" },
    x: { kind: "number", label: "Centre x", min: 0, max: 1, default: 0.5 },
    y: { kind: "number", label: "Centre y", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    const batch = new SpriteBatch(ctx.gl, 700);
    return {
      render(f) {
        const a = f.analysis;
        const life = f.params.life as number;
        const speed = f.params.speed as number;
        const spread = f.params.spread as number;
        const trail = f.params.trail as number;
        const grav = f.params.gravity as number;
        const perBurst = f.params.count as number;
        const origin = f.params.origin as string;
        const bright = f.params.brightness as number;
        const short = Math.min(f.w, f.h);
        const sizeK = (f.params.size as number) * (f.h / 720);
        const draft = f.quality === "draft" ? 0.5 : 1;
        const lookMs = life * 1000;
        const pending: Pending[] = [];
        SOURCES.forEach((s, si) => {
          if (!f.params[s.id]) return;
          for (const e of eventsIn(triggerList(a, s.id), f.tMs - lookMs, f.tMs) as Event2[]) pending.push({ t: e[0], strength: e[1] / 255, src: si });
        });
        pending.sort((p, q) => q.t - p.t);
        batch.begin(f.opacity);
        let budget = PARTICLE_CAP;
        for (const ev of pending) {
          if (budget < 8) break;
          const src = SOURCES[ev.src] as (typeof SOURCES)[number];
          const col: RGB = pickColor(f.palette, src.color);
          const evKey = Math.round(ev.t) + ev.src * 7919;
          const age = (f.tMs - ev.t) / 1000;
          const age01 = age / life;
          const rr = (k: number) => rnd(f.seed, evKey, k);
          let ox = f.w * (f.params.x as number);
          let oy = f.h * (1 - (f.params.y as number));
          let baseAng = -Math.PI / 2;
          if (origin === "scatter") {
            ox = f.w * lerp(0.12, 0.88, rr(1));
            oy = f.h * lerp(0.18, 0.78, rr(2));
          } else if (origin === "bottom") {
            ox = f.w * lerp(0.1, 0.9, rr(1));
            oy = f.h * 1.0;
          } else if (origin === "sides") {
            const left = rr(1) < 0.5;
            ox = left ? 0 : f.w;
            oy = f.h * lerp(0.4, 0.95, rr(2));
            baseAng = left ? -Math.PI / 4 : (-3 * Math.PI) / 4;
          }
          const full = spread > 0.97 && origin !== "bottom" && origin !== "sides";
          const n = Math.min(budget, Math.max(4, Math.round(perBurst * src.scale * (0.45 + 0.55 * ev.strength) * draft)));
          budget -= n;
          const v0Base = short * 0.62 * speed * (0.65 + 0.55 * ev.strength);
          const k = 1.5;
          for (let j = 0; j < n; j++) {
            const r = (q: number) => rnd(f.seed, evKey * 131 + j, q + 5);
            const ang = full ? (j / n) * Math.PI * 2 + r(0) * 0.9 : baseAng + (r(0) - 0.5) * Math.PI * spread * 1.6;
            const v0 = v0Base * lerp(0.3, 1, Math.sqrt(r(1)));
            const dist = dampedDistance(v0, k, age);
            const dxs = Math.cos(ang);
            const dys = Math.sin(ang);
            const g = f.h * 0.45 * grav;
            const x = ox + dxs * dist;
            const y = oy + dys * dist + 0.5 * g * age * age;
            const e = Math.exp(-k * age);
            const vx = dxs * v0 * e;
            const vy = dys * v0 * e + g * age;
            const sp = Math.hypot(vx, vy);
            const rad = lerp(1.0, 2.5, r(2)) * sizeK;
            const fade = Math.pow(Math.max(0, 1 - age01), 1.5) * (0.75 + 0.25 * Math.sin(age * (12 + r(3) * 14) + r(4) * 6));
            const alpha = fade * (0.55 + 0.45 * ev.strength);
            if (trail > 0.04) {
              const hl = Math.max(rad, Math.min(sp * 0.13 * trail, 140 * sizeK));
              const ux = vx / (sp || 1);
              const uy = vy / (sp || 1);
              batch.add(Sprite.streak, x - ux * (hl - rad), y - uy * (hl - rad), hl, rad, col, alpha, Math.atan2(vy, vx), 0, 0, bright);
            } else {
              batch.add(Sprite.ember, x, y, rad * 2, rad * 2, col, alpha, 0, 0, 0.6, bright);
            }
          }
          // The shock ring and flash at the origin, for the first 0.4 s only.
          if (age < 0.4) {
            const q = age / 0.4;
            const ease = 1 - Math.pow(1 - q, 3);
            const rad = short * 0.07 * (0.5 + speed * 0.5) * (0.4 + ease);
            batch.add(Sprite.ring, ox, oy, rad, rad, col, Math.pow(1 - q, 2) * 1.1 * ev.strength, 0, 0.05, 0, bright);
            const fl = 1 - smoothstep(0, 0.14, age);
            batch.add(Sprite.ember, ox, oy, short * 0.03, short * 0.03, col, fl * 0.9 * ev.strength, 0, 0, 1, bright * 1.4);
          }
        }
        batch.draw(f.w, f.h, (f.params.glow as number) * 0.8);
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
