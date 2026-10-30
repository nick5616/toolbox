/**
 * Embers (SPEC.md §6.7 #21): rising embers and fast sparks. Every particle is
 * a slot that is reborn every few seconds; its position is a closed form of
 * (slot, cycle, age) and the cumulative bass, so any frame can be drawn alone.
 * The song's energy decides how many slots are lit, the kick makes them flare.
 */
import { SpriteBatch, channelId, COLOR_OPTIONS, dampedDistance, lerp, pickColor, rnd, smoothstep } from "./_particles";
import { Sprite } from "./_sprites";
import { registerLayer } from "./registry";

registerLayer({
  type: "embers",
  label: "Embers",
  group: "particles",
  icon: "flame",
  params: {
    count: { kind: "number", label: "Particles", min: 20, max: 600, default: 260, step: 1 },
    rise: { kind: "number", label: "Rise speed", min: 0, max: 2, default: 0.8 },
    size: { kind: "number", label: "Size", min: 0.3, max: 3, default: 1 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.6 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, default: 0.5 },
    sparks: { kind: "number", label: "Sparks", min: 0, max: 1, default: 0.4 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.7 },
    react: { kind: "number", label: "Follows the music", min: 0, max: 1, default: 1 },
    color: { kind: "enum", label: "Colour", options: COLOR_OPTIONS, default: "duo" },
  },
  create(ctx) {
    const batch = new SpriteBatch(ctx.gl, 640);
    return {
      render(f) {
        const a = f.analysis;
        const n = Math.round(f.params.count as number);
        const rise = f.params.rise as number;
        const sizeK = (f.params.size as number) * (f.h / 720);
        const sway = f.params.sway as number;
        const sparks = f.params.sparks as number;
        const bright = f.params.brightness as number;
        const react = f.params.react as number;
        const mode = f.params.color as string;
        const draft = f.quality === "draft" ? 0.5 : 1;
        const bassCh = channelId(a, "bass.level", "mix.bass");
        const energy = f.signals.value("mix.level", f.tMs);
        const kick = f.signals.value("kick", f.tMs);
        const lit = lerp(1, 0.18 + 0.95 * energy, react) * draft;
        const flare = 1 + 0.9 * kick * react;
        const t = f.motionSec;
        const seed = f.seed;
        batch.begin(f.opacity);
        for (let i = 0; i < n; i++) {
          // Thin the field by energy: each slot has its own threshold.
          const thr = rnd(seed, i, 9);
          const vis = smoothstep(thr - 0.05, thr, lit);
          if (vis <= 0) continue;
          const isSpark = rnd(seed, i, 0) < sparks * 0.45;
          const L = isSpark ? lerp(0.8, 1.9, rnd(seed, i, 1)) : lerp(3.5, 7.5, rnd(seed, i, 1));
          const u = (t + rnd(seed, i, 2) * L) / L;
          const cyc = Math.floor(u);
          const age01 = u - cyc;
          const age = age01 * L;
          const r = (k: number) => rnd(seed, i, k + 10, cyc);
          const col = pickColor(f.palette, mode, mode === "duo" ? r(0) : r(0) * 4);
          const x0 = f.w * (0.5 + (r(1) - 0.5) * 1.08);
          const flick = 0.78 + 0.22 * Math.sin(age * (7 + r(2) * 9) + r(3) * 6.28);
          if (isSpark) {
            const ang = -Math.PI / 2 + (r(4) - 0.5) * 1.5;
            const v0 = f.h * lerp(0.55, 1.15, r(5)) * (0.7 + 0.5 * rise);
            const g = f.h * 0.4;
            const k = 1.5;
            const dist = dampedDistance(v0, k, age);
            const x = x0 + Math.cos(ang) * dist;
            const y = f.h * (0.97 + 0.05 * r(6)) + Math.sin(ang) * dist + 0.5 * g * age * age;
            const e = Math.exp(-k * age);
            const vx = Math.cos(ang) * v0 * e;
            const vy = Math.sin(ang) * v0 * e + g * age;
            const sp = Math.hypot(vx, vy);
            const rad = lerp(0.8, 1.7, r(7)) * sizeK;
            const hl = Math.max(rad, Math.min(sp * 0.05, 46 * sizeK));
            const dx = vx / (sp || 1);
            const dy = vy / (sp || 1);
            const alpha = vis * smoothstep(0, 0.04, age01) * Math.pow(1 - age01, 1.2) * flick;
            batch.add(Sprite.streak, x - dx * (hl - rad), y - dy * (hl - rad), hl, rad, col, alpha, Math.atan2(vy, vx), 0, 0, bright * 1.5 * flare);
            continue;
          }
          const speed = lerp(0.6, 1.4, r(4));
          const bassInt = a.cum(bassCh, f.tMs) - a.cum(bassCh, f.tMs - age * 1000);
          const dist = rise * f.h * 0.14 * speed * (0.55 * age + 0.9 * bassInt);
          const wind = (a.cum("mix.level", f.tMs) - a.cum("mix.level", f.tMs - age * 1000)) * f.w * 0.03 * (r(5) - 0.5) * 2;
          const x = x0 + sway * f.w * 0.035 * Math.sin(age * (0.7 + r(6) * 1.3) + r(7) * 6.28) + wind;
          const y = f.h * 1.03 - dist;
          const sz = Math.pow(r(8), 2.2);
          const rad = (1.8 + 5.5 * sz) * sizeK * (1 - 0.5 * age01);
          const alpha = vis * smoothstep(0, 0.07, age01) * (1 - smoothstep(0.5, 1, age01)) * flick;
          batch.add(Sprite.ember, x, y, rad * 2.2, rad * 2.2, col, alpha * (1 - 0.45 * sz), 0, 0, Math.pow(1 - age01, 1.5), bright * (1.15 - 0.55 * age01) * flare);
        }
        batch.draw(f.w, f.h, (f.params.glow as number) * 0.9);
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
