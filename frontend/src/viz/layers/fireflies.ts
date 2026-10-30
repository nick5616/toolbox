/**
 * Fireflies (SPEC.md §6.7 #23): soft motes drifting on slow closed-form loops
 * in three depth bands (tiny and crisp far away, large soft bokeh up close).
 * They brighten with the vocals and flash on words; the whole song's energy
 * speeds their drift through the cumulative signal.
 */
import { SpriteBatch, COLOR_OPTIONS, lerp, pickColor, rnd } from "./_particles";
import { Sprite } from "./_sprites";
import { registerLayer } from "./registry";

registerLayer({
  type: "fireflies",
  label: "Fireflies",
  group: "particles",
  icon: "sparkle",
  params: {
    count: { kind: "number", label: "Motes", min: 8, max: 200, default: 70, step: 1 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.6 },
    size: { kind: "number", label: "Size", min: 0.4, max: 3, default: 1 },
    drift: { kind: "number", label: "Drift", min: 0, max: 2, default: 0.7 },
    twinkle: { kind: "number", label: "Twinkle", min: 0, max: 1, default: 0.7 },
    bokeh: { kind: "number", label: "Soft foreground", min: 0, max: 1, default: 0.5 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.5 },
    react: { kind: "number", label: "Follows the voice", min: 0, max: 1, default: 1 },
    color: { kind: "enum", label: "Colour", options: COLOR_OPTIONS, default: "duo" },
  },
  create(ctx) {
    const batch = new SpriteBatch(ctx.gl, 256);
    return {
      render(f) {
        const a = f.analysis;
        const n = Math.round((f.params.count as number) * (f.quality === "draft" ? 0.6 : 1));
        const glow = f.params.glow as number;
        const sizeK = (f.params.size as number) * (f.h / 720);
        const drift = f.params.drift as number;
        const tw = f.params.twinkle as number;
        const bok = f.params.bokeh as number;
        const bright = f.params.brightness as number;
        const react = f.params.react as number;
        const mode = f.params.color as string;
        const voice = f.signals.value("vocals.level", f.tMs, 30, 400);
        const word = f.signals.value("word.pulse", f.tMs);
        const lift = lerp(0.55, 0.55 + 0.9 * voice, react) * (0.6 + 0.8 * glow);
        const T = f.motionSec * drift * 0.45 + a.cum("mix.level", f.tMs) * 0.5 * drift;
        const seed = f.seed;
        batch.begin(f.opacity);
        for (let i = 0; i < n; i++) {
          const depth = rnd(seed, i, 0); // 0 far .. 1 near
          const bx = rnd(seed, i, 1);
          const by = rnd(seed, i, 2);
          const sp = lerp(0.5, 1.5, depth);
          const ph = rnd(seed, i, 3) * 6.2832;
          const x = f.w * (bx * 1.1 - 0.05) + f.w * 0.05 * (0.4 + depth) * (Math.sin(T * 0.6 * sp + ph) + 0.5 * Math.sin(T * 1.3 * sp + ph * 2.1));
          const y = f.h * (by * 1.1 - 0.05) + f.h * 0.06 * (0.4 + depth) * (Math.cos(T * 0.5 * sp + ph * 1.7) + 0.5 * Math.sin(T * 1.1 * sp + ph));
          const blinkHz = 0.12 + rnd(seed, i, 4) * 0.35;
          const blink = Math.pow(0.5 + 0.5 * Math.sin(f.motionSec * blinkHz * 6.2832 + ph * 3), 2.2);
          const lum = (1 - tw) + tw * (0.12 + 0.88 * blink);
          const flash = 1 + 1.4 * word * react * (rnd(seed, i, 5) < 0.5 ? 1 : 0.3);
          const col = pickColor(f.palette, mode, mode === "duo" ? rnd(seed, i, 6) : rnd(seed, i, 6) * 4);
          if (depth > 0.82 && bok > 0) {
            const r = lerp(16, 38, rnd(seed, i, 7)) * sizeK * (0.6 + 0.6 * bok);
            batch.add(Sprite.bokeh, x, y, r, r, col, 0.3 * bok * (0.4 + 0.6 * lum) * (0.7 + 0.5 * voice * react), 0, 0.35, 0, bright * 0.9, false);
          } else {
            const r = lerp(1.6, 5.2, depth) * sizeK;
            batch.add(Sprite.ember, x, y, r * 2.4, r * 2.4, col, Math.min(1, lum * lift * 1.1) * lerp(0.6, 1, depth), 0, 0, 0.55, bright * flash);
          }
        }
        batch.draw(f.w, f.h, glow * 1.1);
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
