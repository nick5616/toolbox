/**
 * Waveform ribbons (SPEC.md §6.7 #13): up to four layered ribbons that taper
 * at both ends, each with soft trails of its own recent past. The source is
 * the spectrum (a carrier shaped by the spectrum) or the raw waveform.
 */
import { LineBatch } from "../gl/lines";
import { buildRamp, basics, catmull, clamp, commonParams, mirrorU, rampAt, TAU } from "./l2util";
import { registerLayer } from "./registry";

const TRAILS = 3;
const TRAIL_MS = 55;

registerLayer({
  type: "ribbons",
  label: "Ribbons",
  group: "shape",
  icon: "audio-waveform",
  params: {
    layers: { kind: "number", label: "Ribbons", min: 1, max: 4, default: 3, step: 1 },
    amplitude: { kind: "number", label: "Amplitude", min: 0, max: 1, default: 0.5 },
    source: { kind: "enum", label: "Source", options: ["spectrum", "wave"], default: "spectrum" },
    thickness: { kind: "number", label: "Thickness", min: 0.002, max: 0.03, default: 0.011 },
    trail: { kind: "number", label: "Trails", min: 0, max: 1, default: 0.55 },
    speed: { kind: "number", label: "Flow", min: 0, max: 2, default: 0.6 },
    span: { kind: "number", label: "Width", min: 0.3, max: 1, default: 0.92 },
    ...commonParams({ glow: 0.6, brightness: 1.6 }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 32768);
    const spec = new Float32Array(64);
    const wave = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const bs = basics(f);
        const p = f.params;
        const nl = Math.round(p.layers as number);
        const N = f.quality === "draft" ? 96 : 180;
        const ramp = buildRamp(f.palette, p.color as string);
        const useWave = p.source === "wave";
        const kick = f.signals.value("kick", f.tMs);
        const amp = (p.amplitude as number) * f.h * 0.42 * bs.scale;
        const wPx = f.w * (p.span as number);
        
        const thick = (p.thickness as number) * bs.short * 0.5 * (1 + 0.25 * kick);
        const trail = p.trail as number;
        const flow = p.speed as number;
        const cosR = Math.cos(bs.rot);
        const sinR = Math.sin(bs.rot);
        lines.begin(bs.glowPx, 0.55);
        const phaseBase = f.motionSec * flow + f.analysis.cum("mix.level", f.tMs) * flow * 1.6;
        for (let tr = TRAILS; tr >= 0; tr--) {
          if (tr > 0 && trail <= 0.02) continue;
          const tt = f.tMs - tr * TRAIL_MS;
          if (useWave) f.analysis.vector("wave", tt, wave);
          else f.analysis.vector("spectrum", tt, spec);
          const phaseT = phaseBase - tr * (TRAIL_MS / 1000) * flow;
          const lv = f.signals.value("mix.level", tt);
          const fade = tr === 0 ? 1 : trail * 0.5 * (1 - tr / (TRAILS + 1));
          for (let k = 0; k < nl; k++) {
            const fk = 1.3 + k * 0.85;
            const phk = k * 2.1 + phaseT * (1 + k * 0.35) * (k % 2 === 0 ? 1 : -1);
            lines.start(false);
            for (let i = 0; i < N; i++) {
              const x = i / (N - 1);
              const env = Math.pow(Math.sin(Math.PI * x), 0.75);
              let v: number;
              let local: number;
              if (useWave) {
                const w = catmull(wave, clamp(x * 63 + k * 2.5, 0, 63));
                v = w * 1.3 * (0.6 + 0.4 * Math.sin(phk + x * 6)) + 0.12 * Math.sin(x * TAU * fk + phk);
                local = Math.abs(w);
              } else {
                const s = catmull(spec, mirrorU(x) * 63);
                local = s;
                v = Math.sin(x * TAU * fk * 1.6 + phk) * (0.12 + 1.5 * s * (0.5 + lv));
              }
              const yo = v * amp * env;
              const lx = (x - 0.5) * wPx;
              const px = bs.cx + lx * cosR - yo * sinR;
              const py = bs.cy + lx * sinR + yo * cosR;
              rampAt(ramp, k * 0.22 + x * 0.55, col);
              const g = bs.bright * (0.55 + 0.6 * local);
              const hw = Math.max(0.6, thick * (0.25 + 0.75 * env) * (0.75 + 0.5 * local) * (tr === 0 ? 1 : 0.7));
              lines.add(px, py, hw, col[0] * g, col[1] * g, col[2] * g, bs.a * fade * (0.45 + 0.55 * env) * (1 - 0.12 * k));
            }
            lines.end();
          }
        }
        lines.draw(f.w, f.h);
      },
      dispose() {
        lines.dispose();
      },
    };
  },
});
