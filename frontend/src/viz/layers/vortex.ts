/**
 * Vortex (SPEC.md §6.7 #18): curved arms spiralling out of a bright core. Each
 * arm's length and twist follow its spectrum bin; the whole swirl spins with
 * the bass and tightens on every kick.
 */
import { LineBatch } from "../gl/lines";
import { QuadBatch } from "../gl/quads";
import { buildRamp, basics, catmull, clamp, commonParams, mirrorU, pushDot, pushSoft, rampAt, SHADE_MULTI, TAU } from "./l2util";
import { registerLayer } from "./registry";

registerLayer({
  type: "vortex",
  label: "Vortex",
  group: "shape",
  icon: "tornado",
  params: {
    lines: { kind: "number", label: "Arms", min: 24, max: 160, default: 88, step: 1 },
    twist: { kind: "number", label: "Twist", min: 0, max: 2, default: 1 },
    length: { kind: "number", label: "Length", min: 0.1, max: 0.8, default: 0.44 },
    thickness: { kind: "number", label: "Thickness", min: 0.001, max: 0.012, default: 0.0035 },
    spin: { kind: "number", label: "Spin", min: -2, max: 2, default: 0.5 },
    ...commonParams({ glow: 0.5, brightness: 1.5 }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 65536);
    const quads = new QuadBatch(ctx.gl, SHADE_MULTI, 16);
    const spec = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const arms = Math.round(p.lines as number);
        const S = f.quality === "draft" ? 12 : 22;
        const ramp = buildRamp(f.palette, p.color as string);
        const bass = f.signals.value("bass.level", f.tMs);
        const kick = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const maxLen = (p.length as number) * b.short * b.scale;
        const tw = (p.twist as number) * (1 + 0.5 * bass) * (1 + 0.25 * kick);
        const spin = b.rot + (p.spin as number) * (f.motionSec * 0.08 + f.analysis.cum("bass.level", f.tMs) * 0.9);
        const thick = (p.thickness as number) * b.short * 0.5;
        const inner = b.short * 0.02 * b.scale;
        f.analysis.vector("spectrum", f.tMs, spec);
        lines.begin(b.glowPx, 0.5);
        for (let i = 0; i < arms; i++) {
          const phi = i / arms;
          const u = mirrorU(phi);
          const v = clamp(catmull(spec, u * 63) * 1.1);
          const len = maxLen * (0.22 + 0.9 * v);
          const base = phi * TAU + spin;
          const twist = (0.35 + 1.1 * v) * tw * Math.PI * 0.6;
          lines.start(false);
          rampAt(ramp, u * 0.9, col);
          for (let j = 0; j < S; j++) {
            const t = j / (S - 1);
            const r = inner + len * t;
            const ang = base + twist * Math.pow(t, 1.35);
            const g = b.bright * (0.45 + 0.8 * v);
            const al = b.a * (0.12 + 0.88 * v) * (0.15 + 0.85 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5));
            lines.add(b.cx + Math.cos(ang) * r, b.cy + Math.sin(ang) * r, Math.max(0.5, thick * (0.45 + v) * (1 - 0.65 * t)), col[0] * g, col[1] * g, col[2] * g, al);
          }
          lines.end();
        }
        lines.draw(f.w, f.h);
        quads.begin();
        const gc = f.palette.glow;
        pushSoft(quads, b.cx, b.cy, b.short * 0.16 * b.scale * (1 + 0.5 * kick), gc[0] * 1.3, gc[1] * 1.3, gc[2] * 1.3, b.a * (0.25 + 0.45 * level + 0.3 * kick), 2.4);
        pushDot(quads, b.cx, b.cy, Math.max(2, b.short * 0.006 * (1 + kick)), f.palette.accent[0] * b.bright, f.palette.accent[1] * b.bright, f.palette.accent[2] * b.bright, b.a, 2);
        quads.draw(f.w, f.h, b.glowPx * 6 + 2, (pr) => pr.f1("u_glow", b.glowPx));
      },
      dispose() {
        lines.dispose();
        quads.dispose();
      },
    };
  },
});
