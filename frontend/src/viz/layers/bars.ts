/**
 * Spectrum bars (SPEC.md §6.7 #11): straight, mirrored or reflected bars with
 * rounded SDF caps and falling peak caps. Peaks are computed from the last
 * second of the spectrum, so any frame can be drawn on its own.
 */
import { QuadBatch, SHADE_ROUND_BOX } from "../gl/quads";
import { mixLinear } from "../palette";
import { registerLayer } from "./registry";

const PEAK_LOOKBACK = 10; // samples, 100 ms apart

registerLayer({
  type: "bars",
  label: "Spectrum bars",
  group: "shape",
  icon: "chart-column",
  params: {
    count: { kind: "number", label: "Bars", min: 16, max: 128, default: 64, step: 1 },
    height: { kind: "number", label: "Height", min: 0, max: 1, default: 0.6 },
    width: { kind: "number", label: "Bar width", min: 0.2, max: 0.95, default: 0.7 },
    y: { kind: "number", label: "Baseline", min: 0, max: 1, default: 0.5 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.5 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.6 },
    peakFall: { kind: "number", label: "Peak fall", min: 0, max: 2, default: 0.6 },
    layout: { kind: "enum", label: "Layout", options: ["mirror", "up", "reflect"], default: "mirror" },
    peaks: { kind: "bool", label: "Peak caps", default: true },
  },
  create(ctx) {
    const batch = new QuadBatch(ctx.gl, SHADE_ROUND_BOX, 512);
    const spec = new Float32Array(64);
    const past = new Float32Array(64);
    return {
      render(f) {
        const n = Math.round(f.params.count as number);
        const layout = f.params.layout as string;
        const maxH = (f.params.height as number) * f.h * (layout === "up" ? 0.9 : 0.45);
        const baseY = (1 - (f.params.y as number)) * f.h;
        const slot = f.w / n;
        const bw = slot * (f.params.width as number);
        const bright = f.params.brightness as number;
        const glowPx = (f.params.glow as number) * Math.min(f.w, f.h) * 0.006;
        f.analysis.vector("spectrum", f.tMs, spec);
        batch.begin();
        const fall = f.params.peakFall as number;
        const peakVals = new Float32Array(n);
        if (f.params.peaks) {
          for (let k = 1; k <= PEAK_LOOKBACK; k++) {
            const dt = k * 0.1;
            f.analysis.vector("spectrum", f.tMs - dt * 1000, past);
            for (let i = 0; i < n; i++) {
              const v = (past[Math.floor((i / n) * 64)] ?? 0) - fall * dt * dt;
              if (v > (peakVals[i] ?? 0)) peakVals[i] = v;
            }
          }
        }
        for (let i = 0; i < n; i++) {
          const v = spec[Math.floor((i / n) * 64)] ?? 0;
          const col = mixLinear(f.palette.colors[(Math.floor((i / n) * 4) % 4) as 0 | 1 | 2 | 3], f.palette.colors[((Math.floor((i / n) * 4) + 1) % 4) as 0 | 1 | 2 | 3], ((i / n) * 4) % 1);
          const hh = Math.max(1.5, (v * maxH) / 2);
          const cx = slot * (i + 0.5);
          const a = f.opacity;
          const r = col[0] * bright;
          const g = col[1] * bright;
          const b = col[2] * bright;
          if (layout === "mirror") {
            batch.push(cx, baseY, bw / 2, hh, r, g, b, a, 0, bw / 2);
          } else {
            batch.push(cx, baseY - hh, bw / 2, hh, r, g, b, a, 0, bw / 2);
            if (layout === "reflect") batch.push(cx, baseY + hh * 0.5, bw / 2, hh * 0.5, r * 0.25, g * 0.25, b * 0.25, a * 0.5, 0, bw / 2);
          }
          const pk = Math.max(v, peakVals[i] ?? 0);
          if (f.params.peaks && pk > v + 0.01) {
            const py = layout === "mirror" ? (pk * maxH) / 2 : pk * maxH;
            const capH = Math.max(1.5, f.h * 0.004);
            batch.push(cx, baseY - py - capH, bw / 2, capH, f.palette.accent[0] * bright, f.palette.accent[1] * bright, f.palette.accent[2] * bright, a, 0, capH);
            if (layout === "mirror") batch.push(cx, baseY + py + capH, bw / 2, capH, f.palette.accent[0] * bright, f.palette.accent[1] * bright, f.palette.accent[2] * bright, a, 0, capH);
          }
        }
        batch.draw(f.w, f.h, glowPx * 3, (p) => p.f1("u_glow", glowPx));
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
