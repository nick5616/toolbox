/**
 * Pitch ribbon (SPEC.md §6.7 #20): the vocal melody drawn as a ribbon over the
 * last few seconds, newest at the playhead. The ribbon swells with the vocal
 * level and is thickest on held notes; gaps in singing are gaps in the line.
 * Everything is sampled from the analysis history, so any frame stands alone.
 */
import { LineBatch } from "../gl/lines";
import { QuadBatch } from "../gl/quads";
import { buildRamp, basics, clamp, commonParams, pushDot, pushRing, pushSoft, rampAt, SHADE_MULTI, smooth5, smoothstep, voicedRuns } from "./l2util";
import { registerLayer } from "./registry";

registerLayer({
  type: "pitchribbon",
  label: "Pitch ribbon",
  group: "shape",
  icon: "mic-vocal",
  params: {
    span: { kind: "number", label: "History (s)", min: 2, max: 6, default: 4 },
    height: { kind: "number", label: "Height", min: 0.1, max: 0.9, default: 0.55 },
    range: { kind: "number", label: "Pitch range", min: 0.8, max: 3, default: 1.7 },
    width: { kind: "number", label: "Width", min: 0.002, max: 0.03, default: 0.016 },
    playhead: { kind: "number", label: "Playhead", min: 0.5, max: 0.95, default: 0.8 },
    staff: { kind: "bool", label: "Guide lines", default: true },
    ...commonParams({ glow: 0.65, brightness: 1.7, color: "cycle" }),
  },
  create(ctx) {
    const lines = new LineBatch(ctx.gl, 16384);
    const quads = new QuadBatch(ctx.gl, SHADE_MULTI, 64);
    const col: [number, number, number] = [0, 0, 0];
    const N = 168;
    const pitch = new Float32Array(N);
    const voiced = new Float32Array(N);
    const level = new Float32Array(N);
    const held = new Float32Array(N);
    return {
      render(f) {
        const b = basics(f);
        const p = f.params;
        const span = (p.span as number) * 1000;
        const ramp = buildRamp(f.palette, p.color as string);
        const hPx = (p.height as number) * f.h * b.scale;
        const range = p.range as number;
        const headX = f.w * (p.playhead as number);
        const x0 = f.w * 0.04;
        const base = (p.width as number) * b.short * 0.5;
        const t0 = f.tMs - span;
        const heldNotes = f.analysis.held().filter((h) => h[1] > t0 - 200 && h[0] < f.tMs + 200);
        const havePitch = f.analysis.has("vocals.pitch");
        for (let i = 0; i < N; i++) {
          const tt = t0 + (i / (N - 1)) * span;
          pitch[i] = havePitch ? f.analysis.sample("vocals.pitch", tt) : 0.5;
          voiced[i] = f.analysis.sample("vocals.voiced", tt);
          level[i] = f.signals.value("vocals.level", tt);
          let hv = 0;
          for (const h of heldNotes) hv = Math.max(hv, clamp(Math.min((tt - h[0] + 150) / 200, (h[1] + 150 - tt) / 200)));
          held[i] = hv;
        }
        smooth5(pitch);
        const yOf = (pv: number) => b.cy - (clamp((pv - 0.5) * range + 0.5, -0.05, 1.05) - 0.5) * hPx;
        const xOf = (i: number) => x0 + (i / (N - 1)) * (headX - x0);

        lines.begin(b.glowPx, 0.55);
        if (p.staff as boolean) {
          const acc = f.palette.glow;
          for (let k = -2; k <= 2; k++) {
            const y = b.cy + (k / 2) * hPx * 0.5;
            lines.start(false);
            lines.add(x0, y, 0.6, acc[0], acc[1], acc[2], 0);
            lines.add((x0 + headX) / 2, y, 0.6, acc[0], acc[1], acc[2], b.a * (k === 0 ? 0.06 : 0.03));
            lines.add(headX, y, 0.6, acc[0], acc[1], acc[2], b.a * (k === 0 ? 0.12 : 0.05));
            lines.add(f.w * 0.97, y, 0.6, acc[0], acc[1], acc[2], 0);
            lines.end();
          }
        }
        const runs = voicedRuns(voiced, 0.5, 2);
        for (const [a, z] of runs) {
          lines.start(false);
          for (let i = a; i <= z; i++) {
            const u = i / (N - 1);
            const age = smoothstep(0, 0.35, u) * (0.35 + 0.65 * u);
            const lv = clamp(level[i] as number * 1.3);
            const hw = base * (0.45 + 0.9 * lv) * (1 + 0.85 * (held[i] as number)) * (0.35 + 0.65 * u);
            rampAt(ramp, 0.55 - u * 0.5 + (held[i] as number) * 0.1, col);
            const g = b.bright * (0.6 + 0.5 * lv + 0.5 * (held[i] as number));
            lines.add(xOf(i), yOf(pitch[i] as number), hw, col[0] * g, col[1] * g, col[2] * g, b.a * age);
          }
          lines.end();
        }
        lines.draw(f.w, f.h);

        // playhead
        quads.begin();
        const lastI = N - 1;
        const singing = (voiced[lastI] as number) >= 0.5;
        const hy = yOf(pitch[lastI] as number);
        const lv = clamp(level[lastI] as number * 1.3);
        const hv = held[lastI] as number;
        rampAt(ramp, 0.05, col);
        const gc = f.palette.accent;
        const r = base * (1.4 + 1.4 * lv + 1.2 * hv);
        if (singing) {
          pushSoft(quads, headX, hy, r * 5, col[0] * 1.2, col[1] * 1.2, col[2] * 1.2, b.a * (0.18 + 0.4 * lv + 0.25 * hv), 2.2);
          pushDot(quads, headX, hy, r, gc[0] * b.bright, gc[1] * b.bright, gc[2] * b.bright, b.a);
          if (hv > 0.05) pushRing(quads, headX, hy, r * (1.8 + 0.5 * hv), Math.max(1, base * 0.35), gc[0] * b.bright, gc[1] * b.bright, gc[2] * b.bright, b.a * hv * 0.8);
        } else {
          pushRing(quads, headX, hy, Math.max(3, base * 1.1), 1.2, gc[0], gc[1], gc[2], b.a * 0.3, 0.5);
        }
        quads.draw(f.w, f.h, b.glowPx * 6 + 2, (pr) => pr.f1("u_glow", b.glowPx));
      },
      dispose() {
        lines.dispose();
        quads.dispose();
      },
    };
  },
});
