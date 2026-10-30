/**
 * Radial bars (SPEC.md §6.7 #12): spectrum bars around a centre glow. Bass sits
 * at the bottom and the spectrum mirrors left/right. The inner ring and glow
 * pulse with the kick, bars carry falling peak dots.
 */
import { QuadBatch } from "../gl/quads";
import { buildRamp, basics, catmull, clamp, commonParams, mirrorU, pushBox, pushDot, pushRing, pushSoft, rampAt, SHADE_MULTI, TAU } from "./l2util";
import { registerLayer } from "./registry";

const PEAK_STEPS = 6;

registerLayer({
  type: "radial",
  label: "Radial bars",
  group: "shape",
  icon: "sun",
  params: {
    count: { kind: "number", label: "Bars", min: 48, max: 256, default: 144, step: 1 },
    innerR: { kind: "number", label: "Inner radius", min: 0.08, max: 0.5, default: 0.2 },
    length: { kind: "number", label: "Length", min: 0, max: 1, default: 0.22 },
    thickness: { kind: "number", label: "Bar width", min: 0.2, max: 1, default: 0.62 },
    spin: { kind: "number", label: "Spin", min: -1, max: 1, default: 0.15 },
    peaks: { kind: "bool", label: "Peak dots", default: true },
    centerGlow: { kind: "number", label: "Centre glow", min: 0, max: 1, default: 0.6 },
    ...commonParams({ brightness: 1.7 }),
  },
  create(ctx) {
    const batch = new QuadBatch(ctx.gl, SHADE_MULTI, 1024);
    const spec = new Float32Array(64);
    const past = new Float32Array(64);
    const peak = new Float32Array(256);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const n = Math.round(p.count as number);
        const ramp = buildRamp(f.palette, p.color as string);
        const kick = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const bass = f.signals.value("bass.level", f.tMs);
        const inner = (p.innerR as number) * b.short * b.scale * (1 + 0.1 * kick + 0.04 * bass);
        const maxLen = (p.length as number) * b.short * b.scale * 1.2;
        const slot = (TAU * inner) / n;
        const thick = Math.max(1.6, slot * (p.thickness as number));
        const angle0 = b.rot - Math.PI / 2 + (p.spin as number) * (f.motionSec * 0.1 + f.analysis.cum("mix.level", f.tMs) * 0.35);
        f.analysis.vector("spectrum", f.tMs, spec);
        const showPeaks = p.peaks as boolean;
        if (showPeaks) {
          peak.fill(0);
          for (let k = 1; k <= PEAK_STEPS; k++) {
            const dt = k * 0.09;
            f.analysis.vector("spectrum", f.tMs - dt * 1000, past);
            for (let i = 0; i < n; i++) {
              const v = catmull(past, mirrorU(i / n) * 63) - 0.5 * dt * dt - 0.12 * dt;
              if (v > (peak[i] as number)) peak[i] = v;
            }
          }
        }
        batch.begin();
        // centre glow
        const cg = p.centerGlow as number;
        rampAt(ramp, 0.1 + 0.2 * level, col);
        pushSoft(batch, b.cx, b.cy, inner * (1.05 + 0.5 * kick), col[0] * 1.2, col[1] * 1.2, col[2] * 1.2, b.a * cg * (0.18 + 0.5 * kick + 0.25 * level), 2.2);
        // inner ring
        pushRing(batch, b.cx, b.cy, inner * 0.97, Math.max(1.5, b.short * 0.003 * (1 + kick)), f.palette.accent[0] * b.bright, f.palette.accent[1] * b.bright, f.palette.accent[2] * b.bright, b.a * (0.55 + 0.45 * kick), 1.2);
        for (let i = 0; i < n; i++) {
          const phi = i / n;
          const u = mirrorU(phi);
          const v = clamp(catmull(spec, u * 63) * 1.08);
          const len = 2 + (0.03 + v) * maxLen * (1 + 0.15 * kick * (1 - u));
          const th = phi * TAU + angle0;
          const dx = Math.cos(th);
          const dy = Math.sin(th);
          rampAt(ramp, u * 0.92, col);
          const gain = b.bright * (0.55 + 0.75 * v);
          const gap = inner + 3;
          pushBox(batch, b.cx + dx * (gap + len / 2), b.cy + dy * (gap + len / 2), len / 2, thick / 2, col[0] * gain, col[1] * gain, col[2] * gain, b.a, th, thick / 2);
          if (showPeaks) {
            const pk = peak[i] as number;
            if (pk > v + 0.02) {
              const pr = gap + 2 + (0.03 + clamp(pk)) * maxLen * 1.0 + thick;
              pushDot(batch, b.cx + dx * pr, b.cy + dy * pr, Math.max(1.4, thick * 0.55), f.palette.accent[0] * b.bright, f.palette.accent[1] * b.bright, f.palette.accent[2] * b.bright, b.a * 0.9);
            }
          }
        }
        batch.draw(f.w, f.h, b.glowPx * 6 + 2, (pr) => pr.f1("u_glow", b.glowPx));
      },
      dispose() {
        batch.dispose();
      },
    };
  },
});
