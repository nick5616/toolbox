/**
 * Double helix (SPEC.md §6.7 #17): two strands that twist around a horizontal
 * axis, brighter and thicker on the near side, with rungs lit by the spectrum
 * (low notes on the left, highs on the right). The twist advances with the bass.
 */
import { LineBatch } from "../gl/lines";
import { QuadBatch } from "../gl/quads";
import { buildRamp, basics, catmull, clamp, commonParams, pushDot, pushSeg, rampAt, SHADE_MULTI, smoothstep, TAU } from "./l2util";
import { registerLayer } from "./registry";

registerLayer({
  type: "helix",
  label: "Helix",
  group: "shape",
  icon: "dna",
  params: {
    turns: { kind: "number", label: "Turns", min: 0.5, max: 6, default: 2.5 },
    amplitude: { kind: "number", label: "Amplitude", min: 0, max: 1, default: 0.28 },
    rungs: { kind: "number", label: "Rungs", min: 8, max: 64, default: 30, step: 1 },
    thickness: { kind: "number", label: "Thickness", min: 0.002, max: 0.02, default: 0.008 },
    speed: { kind: "number", label: "Twist speed", min: 0, max: 2, default: 0.6 },
    span: { kind: "number", label: "Width", min: 0.3, max: 1, default: 0.9 },
    ...commonParams({ glow: 0.6, brightness: 1.6 }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 16384);
    const quads = new QuadBatch(ctx.gl, SHADE_MULTI, 512);
    const spec = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const N = f.quality === "draft" ? 120 : 220;
        const ramp = buildRamp(f.palette, p.color as string);
        const bass = f.signals.value("bass.level", f.tMs);
        const kick = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const turns = p.turns as number;
        const A = (p.amplitude as number) * f.h * b.scale * (0.55 + 0.6 * bass + 0.15 * kick);
        const wPx = f.w * (p.span as number);
        const rungs = Math.round(p.rungs as number);
        const phase = (p.speed as number) * (f.motionSec * 0.9 + f.analysis.cum("bass.level", f.tMs) * 2.4);
        const thick = (p.thickness as number) * b.short * 0.5;
        const cr = Math.cos(b.rot);
        const sr = Math.sin(b.rot);
        const at = (x: number, yo: number): [number, number] => {
          const lx = (x - 0.5) * wPx;
          return [b.cx + lx * cr - yo * sr, b.cy + lx * sr + yo * cr];
        };
        const taper = (x: number) => smoothstep(0, 0.1, x) * smoothstep(1, 0.9, x);
        f.analysis.vector("spectrum", f.tMs, spec);
        // rungs and nodes first (behind the strands)
        quads.begin();
        for (let i = 0; i < rungs; i++) {
          const x = (i + 0.5) / rungs;
          const ph = TAU * turns * x + phase;
          const e = taper(x);
          const s = clamp(catmull(spec, x * 55) * 1.1);
          const yA = Math.sin(ph) * A * e;
          const yB = -yA;
          const [ax, ay] = at(x, yA);
          const [bx, by] = at(x, yB);
          rampAt(ramp, x * 0.9 + 0.05, col);
          const g = b.bright * (0.25 + 1.1 * s);
          const al = b.a * (0.3 + 0.7 * s) * e;
          pushSeg(quads, ax, ay, bx, by, Math.max(1.4, thick * (0.5 + s * 0.9)), col[0] * g, col[1] * g, col[2] * g, al);
          const za = Math.cos(ph);
          pushDot(quads, ax, ay, Math.max(1.5, thick * (1.2 + 0.5 * za) * (0.8 + s)), col[0] * g * 1.2, col[1] * g * 1.2, col[2] * g * 1.2, al * (0.6 + 0.4 * za));
          pushDot(quads, bx, by, Math.max(1.5, thick * (1.2 - 0.5 * za) * (0.8 + s)), col[0] * g * 1.2, col[1] * g * 1.2, col[2] * g * 1.2, al * (0.6 - 0.4 * za));
        }
        quads.draw(f.w, f.h, b.glowPx * 6 + 2, (pr) => pr.f1("u_glow", b.glowPx));
        // strands
        lines.begin(b.glowPx, 0.55);
        for (let strand = 0; strand < 2; strand++) {
          lines.start(false);
          for (let i = 0; i < N; i++) {
            const x = i / (N - 1);
            const ph = TAU * turns * x + phase + strand * Math.PI;
            const z = Math.cos(ph);
            const e = taper(x);
            const [px, py] = at(x, Math.sin(ph) * A * e);
            rampAt(ramp, x * 0.8 + strand * 0.5, col);
            const near = 0.5 + 0.5 * z;
            const g = b.bright * (0.5 + 0.7 * near) * (0.8 + 0.4 * level);
            lines.add(px, py, thick * (0.45 + 0.9 * near) * (0.3 + 0.7 * e), col[0] * g, col[1] * g, col[2] * g, b.a * (0.3 + 0.7 * near) * (0.2 + 0.8 * e));
          }
          lines.end();
        }
        lines.draw(f.w, f.h);
      },
      dispose() {
        lines.dispose();
        quads.dispose();
      },
    };
  },
});
