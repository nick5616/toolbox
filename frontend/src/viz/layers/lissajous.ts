/**
 * Lissajous curves (SPEC.md §6.7 #16): one to three nested curves whose
 * frequency ratio follows the vocal pitch (gliding between integer ratios, so
 * the figure morphs instead of jumping) and whose phase drifts with the music.
 */
import { LineBatch } from "../gl/lines";
import { buildRamp, basics, commonParams, rampAt, snapSmooth, TAU } from "./l2util";
import { registerLayer } from "./registry";

registerLayer({
  type: "lissajous",
  label: "Lissajous",
  group: "shape",
  icon: "infinity",
  params: {
    layers: { kind: "number", label: "Curves", min: 1, max: 3, default: 2, step: 1 },
    freq: { kind: "number", label: "Base frequency", min: 1, max: 8, default: 3, step: 1 },
    ratio: { kind: "number", label: "Ratio", min: 0.5, max: 3, default: 1.34 },
    pitchMod: { kind: "number", label: "Pitch effect", min: 0, max: 1, default: 0.6 },
    phaseDrift: { kind: "number", label: "Phase drift", min: 0, max: 2, default: 0.5 },
    size: { kind: "number", label: "Size", min: 0.1, max: 0.6, default: 0.38 },
    thickness: { kind: "number", label: "Thickness", min: 0.002, max: 0.02, default: 0.006 },
    ...commonParams({ glow: 0.65, brightness: 1.6 }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 32768);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const nl = Math.round(p.layers as number);
        const N = f.quality === "draft" ? 240 : 420;
        const ramp = buildRamp(f.palette, p.color as string);
        const pitch = f.analysis.has("vocals.pitch") ? f.signals.value("vocals.pitch", f.tMs, 60, 250) : f.signals.value("mix.brightness", f.tMs, 60, 250);
        const level = f.signals.value("mix.level", f.tMs);
        const kick = f.signals.value("kick", f.tMs);
        const fx = Math.round(p.freq as number);
        const ratio = (p.ratio as number) + (pitch - 0.5) * (p.pitchMod as number) * 1.5;
        const drift = p.phaseDrift as number;
        const half = (p.size as number) * b.short * b.scale * (1 + 0.07 * kick);
        const thick = (p.thickness as number) * b.short * 0.5 * (1 + 0.4 * kick);
        const phase = drift * (f.motionSec * 0.22 + f.analysis.cum("mix.onset", f.tMs) * 1.3);
        const cr = Math.cos(b.rot);
        const sr = Math.sin(b.rot);
        lines.begin(b.glowPx, 0.5);
        for (let k = nl - 1; k >= 0; k--) {
          const fy = snapSmooth(fx * ratio + k * 0.0);
          const fxk = fx + k;
          const fyk = k === 0 ? fy : snapSmooth((fx + k) * ratio);
          const sc = 1 - k * 0.24;
          const ph = phase * (1 + k * 0.45) * (k % 2 ? -1 : 1) + k * 0.9;
          const a = half * sc * (1 + 0.12 * level);
          lines.start(true);
          for (let i = 0; i < N; i++) {
            const th = (i / N) * TAU;
            const u = Math.sin(fxk * th + ph) * a;
            const v = Math.sin(fyk * th) * a * 0.92;
            const x = b.cx + u * cr - v * sr;
            const y = b.cy + u * sr + v * cr;
            rampAt(ramp, k * 0.3 + i / N, col);
            const w = 0.75 + 0.25 * Math.cos(th * 2 + ph);
            const g = b.bright * (0.8 - 0.18 * k) * (0.85 + 0.4 * level);
            lines.add(x, y, thick * w * (1 - 0.15 * k), col[0] * g, col[1] * g, col[2] * g, b.a * (1 - 0.22 * k));
          }
          lines.end();
        }
        lines.draw(f.w, f.h);
      },
      dispose() {
        lines.dispose();
      },
    };
  },
});
