/**
 * Wave ring (SPEC.md §6.7 #14, golden-hour's drawWaveRing): noisy rings that
 * wobble with the bass and ride the waveform. With `pair` on, a left ring
 * (blue-tinted) and a right ring (red-tinted) overlap, each swelling with its
 * own side of the stereo balance.
 */
import { LineBatch } from "../gl/lines";
import { buildRamp, basics, catmull, commonParams, mirrorU, rampAt, TAU, wobble } from "./l2util";
import { registerLayer } from "./registry";

const BLUE: [number, number, number] = [0.05, 0.28, 1];
const RED: [number, number, number] = [1, 0.1, 0.12];

registerLayer({
  type: "wavering",
  label: "Wave ring",
  group: "shape",
  icon: "circle-dot",
  params: {
    radius: { kind: "number", label: "Radius", min: 0.08, max: 0.6, default: 0.26 },
    wobble: { kind: "number", label: "Wobble", min: 0, max: 1, default: 0.45 },
    rings: { kind: "number", label: "Rings", min: 1, max: 3, default: 2, step: 1 },
    pair: { kind: "bool", label: "Left/right pair", default: false },
    detail: { kind: "number", label: "Detail", min: 3, max: 24, default: 6, step: 1 },
    thickness: { kind: "number", label: "Thickness", min: 0.002, max: 0.02, default: 0.006 },
    speed: { kind: "number", label: "Speed", min: 0, max: 2, default: 0.7 },
    ...commonParams({ glow: 0.6, brightness: 1.7 }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 32768);
    const wave = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const N = f.quality === "draft" ? 128 : 240;
        const ramp = buildRamp(f.palette, p.color as string);
        const bass = f.signals.value("bass.level", f.tMs);
        const kick = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const balance = f.signals.value("mix.balance", f.tMs, 60, 200);
        const pair = p.pair as boolean;
        const nr = Math.round(p.rings as number);
        const lobes = Math.round(p.detail as number);
        const R0 = (p.radius as number) * b.short * b.scale;
        const wob = (p.wobble as number) * (0.04 + 0.22 * bass + 0.08 * kick);
        const spd = p.speed as number;
        const ph = f.motionSec * spd * 0.9 + f.analysis.cum("bass.level", f.tMs) * spd * 1.4;
        f.analysis.vector("wave", f.tMs, wave);
        const thick = (p.thickness as number) * b.short * 0.5 * (1 + 0.8 * bass + 0.5 * kick);
        lines.begin(b.glowPx, 0.5);
        const sides = pair ? 2 : nr;
        for (let s = 0; s < sides; s++) {
          const ringIdx = pair ? 0 : s;
          const dir = pair ? (s === 0 ? -1 : 1) : 0;
          const side = pair ? (s === 0 ? 1 - balance : balance) * 2 : 1; // ~1 at centre balance
          const r = R0 * (1 + 0.16 * ringIdx) * (1 + 0.09 * kick) * (pair ? 0.5 + 0.5 * side : 1);
          const ox = pair ? dir * R0 * 0.22 : 0;
          const shiftA = ph * (1 + ringIdx * 0.3) * (ringIdx % 2 === 0 ? 1 : -1) + s * 1.7;
          const amp = wob * (pair ? 0.7 + 0.5 * side : 1 + 0.35 * ringIdx);
          lines.start(true);
          for (let i = 0; i < N; i++) {
            const th = (i / N) * TAU;
            const w = catmull(wave, mirrorU(i / N) * 63);
            const off = wobble(th, lobes + ringIdx, shiftA, shiftA * 0.7, shiftA * 0.4) * amp + w * (0.02 + 0.05 * level) * (p.wobble as number);
            const rr = r * (1 + off);
            const x = b.cx + ox + Math.cos(th + b.rot) * rr;
            const y = b.cy + Math.sin(th + b.rot) * rr;
            const g = b.bright * (0.7 + 0.5 * Math.abs(off) / (amp + 0.02) * 0.4 + 0.3 * level);
            if (pair) {
              const base = s === 0 ? BLUE : RED;
              rampAt(ramp, s === 0 ? 0.3 : 0.05, col);
              const k = 0.62;
              lines.add(x, y, thick, (base[0] * k + col[0] * (1 - k)) * g, (base[1] * k + col[1] * (1 - k)) * g, (base[2] * k + col[2] * (1 - k)) * g, b.a * 0.9);
            } else {
              rampAt(ramp, ringIdx * 0.28 + i / N * 0.35, col);
              lines.add(x, y, thick * (1 - 0.18 * ringIdx), col[0] * g, col[1] * g, col[2] * g, b.a * (1 - 0.18 * ringIdx));
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
