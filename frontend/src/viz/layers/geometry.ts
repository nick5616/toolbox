/**
 * Geometry (SPEC.md §6.7 #19): nested polygons that counter-rotate, with
 * edges pushed in and out by the spectrum. Every kick launches rays from the
 * corners and an expanding polygon outline (both closed-form in the event's
 * age, so any frame can be drawn on its own).
 */
import { LineBatch } from "../gl/lines";
import { QuadBatch } from "../gl/quads";
import { buildRamp, basics, catmull, clamp, commonParams, polygonPoints, pushDot, pushSeg, pushSoft, rampAt, SHADE_MULTI, TAU } from "./l2util";
import { registerLayer } from "./registry";

const LOOKBACK_MS = 900;
const SUB = 6;

registerLayer({
  type: "geometry",
  label: "Geometry",
  group: "shape",
  icon: "hexagon",
  params: {
    shapes: { kind: "number", label: "Shapes", min: 3, max: 8, default: 5, step: 1 },
    sides: { kind: "number", label: "Sides", min: 3, max: 8, default: 6, step: 1 },
    size: { kind: "number", label: "Size", min: 0.1, max: 0.6, default: 0.36 },
    roughness: { kind: "number", label: "Edge motion", min: 0, max: 1, default: 0.55 },
    rays: { kind: "number", label: "Kick rays", min: 0, max: 1, default: 0.75 },
    spin: { kind: "number", label: "Spin", min: -1, max: 1, default: 0.3 },
    thickness: { kind: "number", label: "Thickness", min: 0.0015, max: 0.015, default: 0.0045 },
    ...commonParams({ glow: 0.6, brightness: 1.6 }),
  },
  create(ctx) {
    const batch = new QuadBatch(ctx.gl, SHADE_MULTI, 2048);
    const lines = new LineBatch(ctx.gl, 16384);
    const spec = new Float32Array(64);
    const col: [number, number, number] = [0, 0, 0];
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const ns = Math.round(p.shapes as number);
        const sides = Math.round(p.sides as number);
        const ramp = buildRamp(f.palette, p.color as string);
        const kick = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const bass = f.signals.value("bass.level", f.tMs);
        const R = (p.size as number) * b.short * b.scale;
        const rough = p.roughness as number;
        const thick = (p.thickness as number) * b.short;
        const spin = (p.spin as number) * (f.motionSec * 0.25 + f.analysis.cum("mix.level", f.tMs) * 0.6);
        f.analysis.vector("spectrum", f.tMs, spec);
        batch.begin();
        lines.begin(b.glowPx, 0.5);
        const gc = f.palette.glow;
        pushSoft(batch, b.cx, b.cy, R * 0.7, gc[0], gc[1], gc[2], b.a * (0.12 + 0.35 * kick + 0.15 * level), 2.2);
        for (let s = 0; s < ns; s++) {
          const q = (s + 1) / ns;
          const rad = R * (0.2 + 0.8 * q) * (1 + 0.05 * kick * q + 0.03 * bass);
          const dir = s % 2 === 0 ? 1 : -1;
          const rot = b.rot + dir * spin * (0.7 + 0.5 * q) + s * 0.31;
          const corners = polygonPoints(sides, rad, rot, b.cx, b.cy);
          rampAt(ramp, s / ns, col);
          const g = b.bright * (0.6 + 0.6 * (1 - q * 0.5));
          const tk = Math.max(1.3, thick * (0.55 + 0.7 * q));
          const alpha = b.a * (0.95 - 0.4 * q * (1 - 0.5 * level));
          lines.start(true);
          for (let i = 0; i < sides; i++) {
            const A = corners[i] as [number, number];
            const B = corners[(i + 1) % sides] as [number, number];
            const ex = B[0] - A[0];
            const ey = B[1] - A[1];
            const el = Math.hypot(ex, ey) || 1;
            // outward normal of the edge
            const mx = (A[0] + B[0]) / 2 - b.cx;
            const my = (A[1] + B[1]) / 2 - b.cy;
            let nx = -ey / el;
            let ny = ex / el;
            if (nx * mx + ny * my < 0) {
              nx = -nx;
              ny = -ny;
            }
            for (let k = 0; k <= SUB; k++) {
              const t = k / SUB;
              const bin = ((s * 7 + i * 3 + t * 5) / (ns * 7 + sides * 3 + 5)) * 63;
              const v = clamp(catmull(spec, ((i + t) / sides) * 0.9 * 63 * (0.4 + 0.6 * q) + bin * 0.1));
              const d = rough * rad * 0.16 * (v - 0.25) * Math.sin(Math.PI * t) * (1 + 0.5 * kick);
              const x = A[0] + ex * t + nx * d;
              const y = A[1] + ey * t + ny * d;
              if (k < SUB) lines.add(x, y, tk / 2, col[0] * g, col[1] * g, col[2] * g, alpha);
            }
          }
          lines.end();
          // corner studs on the outermost shapes
          if (s >= ns - 2) for (const c of corners) pushDot(batch, c[0], c[1], tk * 1.5, f.palette.accent[0] * b.bright, f.palette.accent[1] * b.bright, f.palette.accent[2] * b.bright, alpha * 0.9);
        }
        // rays + shock outlines from recent kicks
        const rays = p.rays as number;
        if (rays > 0.01) {
          let evs = f.analysis.eventsBetween("kick", f.tMs - LOOKBACK_MS, f.tMs);
          if (f.analysis.events("kick").length === 0) evs = f.analysis.eventsBetween("mix", f.tMs - LOOKBACK_MS, f.tMs);
          for (const [ms, str] of evs) {
            const age = (f.tMs - ms) / 1000;
            const st = (str / 255) * rays;
            const fade = Math.exp(-age / 0.28);
            const head = R * (1 + 1.1 * (1 - Math.exp(-age / 0.11)));
            const tail = R * (1 + 0.15 + 0.8 * (1 - Math.exp(-age / 0.2)));
            const corners = polygonPoints(sides * 2, 1, b.rot + spin * 0.7 + (ms % 7) * 0.05, 0, 0);
            const ids = ((ms / 10) | 0) % 7;
            rampAt(ramp, (ids / 7 + 0.1) % 1, col);
            for (let i = 0; i < corners.length; i++) {
              const c = corners[i] as [number, number];
              if (i % 2 === 1 && st < 0.6) continue;
              const x0 = b.cx + c[0] * tail;
              const y0 = b.cy + c[1] * tail;
              const x1 = b.cx + c[0] * head;
              const y1 = b.cy + c[1] * head;
              pushSeg(batch, x0, y0, x1, y1, Math.max(1.2, thick * 0.8 * fade), col[0] * b.bright, col[1] * b.bright, col[2] * b.bright, b.a * st * fade * 0.9);
            }
            // expanding outline
            const sr = R * (1 + 0.9 * (1 - Math.exp(-age / 0.16)));
            const outline = polygonPoints(sides, sr, b.rot + spin * 0.7, b.cx, b.cy);
            lines.start(true);
            for (const A of outline) lines.add(A[0], A[1], Math.max(0.6, thick * 0.35), f.palette.accent[0] * b.bright, f.palette.accent[1] * b.bright, f.palette.accent[2] * b.bright, b.a * st * fade * 0.5);
            lines.end();
          }
        }
        void TAU;
        lines.draw(f.w, f.h);
        batch.draw(f.w, f.h, b.glowPx * 6 + 2, (pr) => pr.f1("u_glow", b.glowPx));
      },
      dispose() {
        batch.dispose();
        lines.dispose();
      },
    };
  },
});
