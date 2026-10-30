/**
 * Note highway (SPEC.md §6.7 #29): a perspective road whose lanes are the
 * song's instruments (kick, snare, hats, bass, vocals) or five frequency
 * bands. Notes come from the analysis events and reach the fret line exactly at
 * their event time; held vocal notes and bass notes draw sustain tails; each
 * hit flashes its fret button, lane and beam. `reverse` flows the played notes
 * away from the fret instead. Stateless: every frame is computed from events.
 */
import { LineBatch } from "../gl/lines";
import { QuadBatch } from "../gl/quads";
import { BAND_LANES, clamp, hyperDepth, INSTRUMENT_LANES, laneNotes, pushBox, pushRing, pushDot, pushSoft, SHADE_MULTI, smoothstep, type Note } from "./l2util";
import { registerLayer } from "./registry";

const LINGER = 0.4; // seconds a hit keeps flashing at the fret
const FLASH_TAU = 0.14;

/** Index of the first element >= t (binary search over a sorted array). */
export function lowerBound(a: readonly number[], t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((a[m] as number) < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The brightness of a lane's fret flash from its notes at time tMs (0..1.2). Pure. */
export function laneFlash(notes: readonly Note[], tMs: number): number {
  let flash = 0;
  for (const n of notes) {
    const dt = (n.t - tMs) / 1000;
    if (dt > 0.12) continue;
    if (dt > 0) flash = Math.max(flash, 0.35 * (1 - dt / 0.12) * n.s);
    else {
      const age = -dt;
      if (age < LINGER + 0.5) flash = Math.max(flash, (0.45 + 0.75 * n.s) * Math.exp(-age / FLASH_TAU));
      if (n.dur > 0 && tMs <= n.t + n.dur) flash = Math.max(flash, 0.55 + 0.25 * n.s);
    }
  }
  return flash;
}

registerLayer({
  type: "highway",
  label: "Note highway",
  group: "highway",
  icon: "route",
  params: {
    lanes: { kind: "enum", label: "Lanes", options: ["instruments", "bands"], default: "instruments" },
    lookahead: { kind: "number", label: "Look-ahead (s)", min: 1.5, max: 4, default: 2.6 },
    reverse: { kind: "bool", label: "Reverse (played notes recede)", default: false },
    perspective: { kind: "number", label: "Perspective", min: 1, max: 8, default: 3.2 },
    width: { kind: "number", label: "Road width", min: 0.3, max: 1, default: 0.9 },
    horizon: { kind: "number", label: "Horizon", min: 0.04, max: 0.45, default: 0.17 },
    fret: { kind: "number", label: "Fret line", min: 0.6, max: 0.95, default: 0.8 },
    noteSize: { kind: "number", label: "Note size", min: 0.5, max: 1.6, default: 1 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.55 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.6 },
  },
  create(ctx) {
    const fills = new LineBatch(ctx.gl, 8192);
    const strokes = new LineBatch(ctx.gl, 16384);
    const quads = new QuadBatch(ctx.gl, SHADE_MULTI, 1024);
    return {
      render(f) {
        const p = f.params;
        const short = Math.min(f.w, f.h);
        const a = f.opacity;
        const bright = p.brightness as number;
        const glowPx = (p.glow as number) * short * 0.012;
        const L = p.lookahead as number;
        const K = p.perspective as number;
        const reverse = p.reverse as boolean;
        const laneDefs = p.lanes === "bands" ? BAND_LANES : INSTRUMENT_LANES;
        const nl = laneDefs.length;
        const cx = f.w / 2;
        const horizonY = f.h * (p.horizon as number);
        const fretY = f.h * (p.fret as number);
        const fretW = f.w * (p.width as number);
        const horizonW = fretW * 0.12;
        const roadW = (s: number) => horizonW + (fretW - horizonW) * s;
        const yOf = (s: number) => horizonY + s * (fretY - horizonY);
        const laneX = (i: number, s: number) => cx + ((i + 0.5 - nl / 2) / nl) * roadW(s);
        const laneW = (s: number) => roadW(s) / nl;
        const laneColor = (i: number): readonly [number, number, number] => (i < 4 ? f.palette.colors[i as 0 | 1 | 2 | 3] : f.palette.accent);
        const posOf = (dt: number) => hyperDepth(reverse ? Math.max(-dt, 0) : Math.max(dt, 0), K);

        const kickEnv = f.signals.value("kick", f.tMs);
        const level = f.signals.value("mix.level", f.tMs);
        const beatP = f.signals.value("beat.pulse", f.tMs);
        const barP = f.signals.value("bar.pulse", f.tMs);

        // notes per lane
        const t0 = reverse ? f.tMs - L * 1000 : f.tMs - LINGER * 1000 - 100;
        const t1 = reverse ? f.tMs + 150 : f.tMs + L * 1000;
        const notes: Note[][] = [];
        const flashes: number[] = [];
        for (let i = 0; i < nl; i++) {
          const ns = laneNotes(f.analysis, laneDefs[i] as (typeof laneDefs)[number], t0, t1);
          notes.push(ns);
          flashes.push(laneFlash(ns, f.tMs));
        }

        // ---- pass A: lane fills and beams (no glow) ----
        fills.begin(0, 0);
        for (let i = 0; i < nl; i++) {
          const c = laneColor(i);
          const fl = flashes[i] as number;
          const g = bright * (0.5 + 0.5 * fl);
          const base = 0.03 + 0.03 * level + 0.14 * Math.min(1, fl);
          fills.start(false, true, true);
          fills.add(laneX(i, 0.02), yOf(0.02), (laneW(0.02) / 2) * 0.96, c[0] * g, c[1] * g, c[2] * g, 0);
          fills.add(laneX(i, 1), yOf(1), (laneW(1) / 2) * 0.96, c[0] * g, c[1] * g, c[2] * g, a * base);
          fills.end();
          if (fl > 0.03) {
            const sTop = 0.3 + 0.35 * Math.min(1, fl);
            fills.start(false, true, true);
            fills.add(laneX(i, 1), yOf(1), (laneW(1) / 2) * 0.9, c[0] * g * 1.2, c[1] * g * 1.2, c[2] * g * 1.2, a * Math.min(1, fl) * 0.4);
            fills.add(laneX(i, sTop), yOf(sTop), (laneW(sTop) / 2) * 0.9, c[0] * g, c[1] * g, c[2] * g, 0);
            fills.end();
          }
        }
        fills.draw(f.w, f.h);

        // ---- pass B: dividers, road edges, sustains, fret line ----
        strokes.begin(glowPx, 0.5);
        const edge = f.palette.colors[1];
        for (let d = 0; d <= nl; d++) {
          const outer = d === 0 || d === nl;
          const xAt = (s: number) => cx + ((d - nl / 2) / nl) * roadW(s);
          const al = a * (outer ? 0.34 + 0.2 * beatP : 0.1);
          const gg = bright * (outer ? 1 : 0.8);
          strokes.start(false, true);
          strokes.add(xAt(0.02), yOf(0.02), 0.6, edge[0] * gg, edge[1] * gg, edge[2] * gg, 0);
          strokes.add(xAt(0.4), yOf(0.4), Math.max(0.7, short * (outer ? 0.0013 : 0.0007)), edge[0] * gg, edge[1] * gg, edge[2] * gg, al * 0.8);
          strokes.add(xAt(1), yOf(1), Math.max(0.8, short * (outer ? 0.002 : 0.001)), edge[0] * gg, edge[1] * gg, edge[2] * gg, al);
          strokes.end();
        }
        for (let i = 0; i < nl; i++) {
          const c = laneColor(i);
          for (const n of notes[i] as Note[]) {
            if (n.dur <= 0) continue;
            const dtH = (n.t - f.tMs) / 1000;
            const dtT = dtH + n.dur / 1000;
            if (!reverse && (dtT < -0.05 || dtH > L)) continue;
            if (reverse && (-dtT > L || dtH > 0.15)) continue;
            const sH = posOf(dtH);
            const sT = posOf(Math.min(dtT, reverse ? 99 : L));
            if (Math.abs(sH - sT) < 0.002) continue;
            const playing = dtH <= 0 && dtT >= 0;
            const fade = reverse ? 1 - clamp(-dtT / L) : smoothstep(L, L * 0.75, dtH);
            const g = bright * (playing ? 1.25 : 0.85);
            strokes.start(false, false);
            const M = 8;
            for (let k = 0; k <= M; k++) {
              const s = sH + ((sT - sH) * k) / M;
              const tail = k / M;
              strokes.add(laneX(i, s), yOf(s), Math.max(1, laneW(s) * 0.075 * (1 + (playing ? 0.5 * level : 0))), c[0] * g, c[1] * g, c[2] * g, a * fade * (0.55 + 0.35 * n.s) * (1 - 0.35 * tail));
            }
            strokes.end();
          }
        }
        // fret line
        {
          const acc = f.palette.accent;
          const g = bright * (0.8 + 0.8 * kickEnv);
          strokes.start(false, true);
          strokes.add(cx - fretW / 2, fretY, Math.max(1, short * 0.0018 * (1 + kickEnv)), acc[0] * g, acc[1] * g, acc[2] * g, a * (0.5 + 0.4 * beatP + 0.3 * barP));
          strokes.add(cx + fretW / 2, fretY, Math.max(1, short * 0.0018 * (1 + kickEnv)), acc[0] * g, acc[1] * g, acc[2] * g, a * (0.5 + 0.4 * beatP + 0.3 * barP));
          strokes.end();
        }
        strokes.draw(f.w, f.h);

        // ---- pass C: beat lines, soft light, chips, fret buttons ----
        quads.begin();
        const hz = f.palette.glow;
        pushSoft(quads, cx, horizonY, f.w * 0.32, hz[0] * 1.2, hz[1] * 1.2, hz[2] * 1.2, a * (0.06 + 0.2 * level), 2.4);
        // beat and bar lines
        const beats = f.analysis.audio.beats;
        const downs = f.analysis.audio.downbeats;
        const bStart = lowerBound(beats, reverse ? f.tMs - L * 1000 : f.tMs - 100);
        for (let k = bStart; k < beats.length; k++) {
          const bt = beats[k] as number;
          const dt = (bt - f.tMs) / 1000;
          if (!reverse && dt > L) break;
          if (reverse && dt > 0.1) break;
          const s = posOf(dt);
          const di = lowerBound(downs, bt - 1);
          const isBar = di < downs.length && Math.abs((downs[di] as number) - bt) < 2;
          const fade = reverse ? 1 - clamp(-dt / L) : smoothstep(L, L * 0.7, dt);
          const al = a * fade * (isBar ? 0.28 : 0.1);
          const c = f.palette.colors[2];
          pushBox(quads, cx, yOf(s), roadW(s) / 2, Math.max(0.5, short * (isBar ? 0.0016 : 0.0008) * (0.4 + s)), c[0] * bright, c[1] * bright, c[2] * bright, al, 0, 1, 0.3);
        }
        // chips, far to near
        const all: Array<{ lane: number; n: Note; dt: number }> = [];
        for (let i = 0; i < nl; i++) for (const n of notes[i] as Note[]) all.push({ lane: i, n, dt: (n.t - f.tMs) / 1000 });
        all.sort((x, y) => (reverse ? x.dt - y.dt : y.dt - x.dt)); // far to near
        const sizeK = p.noteSize as number;
        for (const { lane, n, dt } of all) {
          if (!reverse && (dt > L || dt < -LINGER)) continue;
          if (reverse && (dt < -L || dt > 0.12)) continue;
          const c = laneColor(lane);
          const s = posOf(dt);
          const age = Math.max(0, -dt);
          let alpha: number;
          let burst = 1;
          if (reverse) alpha = (1 - clamp(age / L)) * (dt > 0 ? 1 - dt / 0.12 : 1);
          else if (dt >= 0) alpha = smoothstep(L, L * 0.78, dt);
          else {
            alpha = Math.exp(-age / 0.1);
            burst = 1 + age * 4;
          }
          if (alpha < 0.01) continue;
          const wLane = laneW(s);
          const hw = wLane * 0.4 * sizeK * burst;
          const hh = Math.max(1.5, wLane * (0.1 + 0.07 * n.s) * sizeK * (n.dur > 0 ? 1.2 : 1));
          const x = laneX(lane, s);
          const y = yOf(s);
          const g = bright * (0.7 + 0.6 * n.s);
          pushBox(quads, x, y, hw, hh, c[0] * g, c[1] * g, c[2] * g, a * alpha, 0, hh, 1);
          pushBox(quads, x, y - hh * 0.35, hw * 0.78, Math.max(0.8, hh * 0.28), g * 0.9, g * 0.9, g * 0.9, a * alpha * 0.8, 0, hh * 0.28, 0.2);
        }
        // fret buttons and fret light
        const btnY = fretY + f.h * 0.058;
        const btnR = Math.min(laneW(1) * 0.3, f.h * 0.04);
        for (let i = 0; i < nl; i++) {
          const c = laneColor(i);
          const fl = Math.min(1.2, flashes[i] as number);
          const x = laneX(i, 1);
          const g = bright * (0.5 + 0.9 * fl);
          pushSoft(quads, x, fretY, laneW(1) * (0.8 + 0.6 * fl), c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, a * (0.05 + 0.6 * fl), 2.2);
          pushRing(quads, x, btnY, btnR, Math.max(1.5, btnR * 0.14 * (1 + fl)), c[0] * g, c[1] * g, c[2] * g, a * (0.45 + 0.55 * Math.min(1, fl)), 1.5);
          if (fl > 0.05) pushDot(quads, x, btnY, btnR * (0.45 + 0.35 * Math.min(1, fl)), c[0] * g * 1.3, c[1] * g * 1.3, c[2] * g * 1.3, a * Math.min(1, fl), 1.5);
          else pushDot(quads, x, btnY, btnR * 0.22, c[0] * g, c[1] * g, c[2] * g, a * 0.5);
        }
        quads.draw(f.w, f.h, glowPx * 6 + 2, (pr) => pr.f1("u_glow", glowPx));
      },
      dispose() {
        fills.dispose();
        strokes.dispose();
        quads.dispose();
      },
    };
  },
});
