/**
 * Oscilloscope (SPEC.md §6.7 #15): the actual waveform as a glowing phosphor
 * line, or an X/Y figure (the waveform against a copy of itself delayed by a
 * quarter cycle; the stereo balance shifts the delay, so a lopsided mix leans
 * the figure). Persistence draws the recent past as fading ghosts.
 */
import { LineBatch } from "../gl/lines";
import { buildRamp, basics, catmull, commonParams, rampAt } from "./l2util";
import { registerLayer } from "./registry";

const GHOST_MS = 24;

registerLayer({
  type: "oscilloscope",
  label: "Oscilloscope",
  group: "shape",
  icon: "activity",
  params: {
    mode: { kind: "enum", label: "Mode", options: ["line", "xy"], default: "line" },
    gain: { kind: "number", label: "Gain", min: 0.2, max: 3, default: 1 },
    persistence: { kind: "number", label: "Persistence", min: 0, max: 1, default: 0.65 },
    thickness: { kind: "number", label: "Thickness", min: 0.002, max: 0.015, default: 0.005 },
    width: { kind: "number", label: "Width", min: 0.3, max: 1, default: 0.88 },
    grid: { kind: "bool", label: "Graticule", default: true },
    ...commonParams({ glow: 0.7, brightness: 1.5, color: "c0" }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 32768);
    const wave = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const xy = p.mode === "xy";
        const ramp = buildRamp(f.palette, p.color as string);
        const N = f.quality === "draft" ? 128 : 220;
        const gain = p.gain as number;
        const pers = p.persistence as number;
        const ghosts = Math.round(pers * 7);
        const level = f.signals.value("mix.level", f.tMs);
        const balance = f.signals.value("mix.balance", f.tMs, 80, 250);
        const thick = (p.thickness as number) * b.short * 0.5;
        const wPx = f.w * (p.width as number);
        const hPx = f.h * 0.3 * b.scale;
        const cr = Math.cos(b.rot);
        const sr = Math.sin(b.rot);
        const place = (u: number, v: number): [number, number] => [b.cx + u * cr - v * sr, b.cy + u * sr + v * cr];
        lines.begin(b.glowPx, 0.6);
        // graticule
        if (p.grid as boolean) {
          const acc = f.palette.glow;
          const ga = b.a * 0.12;
          const hx = xy ? hPx * 1.1 : wPx / 2;
          const hy = xy ? hPx * 1.1 : hPx;
          const lw = Math.max(0.6, b.short * 0.0007);
          const seg = (ax: number, ay: number, bx: number, by: number, al: number) => {
            const A = place(ax, ay);
            const B = place(bx, by);
            lines.start(false);
            lines.add(A[0], A[1], lw, acc[0], acc[1], acc[2], al);
            lines.add(B[0], B[1], lw, acc[0], acc[1], acc[2], al);
            lines.end();
          };
          seg(-hx, 0, hx, 0, ga * 1.6);
          if (xy) seg(0, -hy, 0, hy, ga * 1.6);
          for (let k = -4; k <= 4; k++) {
            if (k === 0) continue;
            seg((k / 4) * hx, -hy * 0.04, (k / 4) * hx, hy * 0.04, ga * 1.4);
            if (xy) seg(-hx * 0.04, (k / 4) * hy, hx * 0.04, (k / 4) * hy, ga * 1.4);
          }
          if (!xy) {
            seg(-hx, -hy, hx, -hy, ga * 0.5);
            seg(-hx, hy, hx, hy, ga * 0.5);
          }
        }
        for (let g = ghosts; g >= 0; g--) {
          const tt = f.tMs - g * GHOST_MS;
          f.analysis.vector("wave", tt, wave);
          const fade = g === 0 ? 1 : Math.pow(0.62, g) * (0.4 + 0.6 * pers);
          const gHw = thick * (g === 0 ? 1 : 0.8);
          lines.start(false);
          if (xy) {
            const D = 14 + (balance - 0.5) * 20;
            const span = 63 - D - 1;
            for (let i = 0; i < N; i++) {
              const t = (i / (N - 1)) * span;
              const u = catmull(wave, t) * gain * hPx * 1.1;
              const v = catmull(wave, t + D) * gain * hPx * 1.1;
              const [px, py] = place(u, -v);
              const e = Math.sin((i / (N - 1)) * Math.PI);
              rampAt(ramp, i / (N - 1) * 0.5, col);
              const gg = b.bright * (0.7 + 0.5 * level);
              lines.add(px, py, gHw * (0.3 + 0.7 * e), col[0] * gg, col[1] * gg, col[2] * gg, b.a * fade * (0.3 + 0.7 * e));
            }
          } else {
            for (let i = 0; i < N; i++) {
              const x = i / (N - 1);
              const v = catmull(wave, x * 63) * gain;
              const e = Math.pow(Math.sin(Math.PI * x), 0.35);
              const [px, py] = place((x - 0.5) * wPx, -v * hPx * 0.95);
              rampAt(ramp, 0.05 + x * 0.35, col);
              const gg = b.bright * (0.75 + 0.45 * Math.abs(v));
              lines.add(px, py, gHw, col[0] * gg, col[1] * gg, col[2] * gg, b.a * fade * e);
            }
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
