/**
 * Particle parts of the 12 motifs (embers, rain, snow, stars, petals, hearts,
 * city lights, lightning). Each is a pure function of the frame: slots with
 * closed-form motion, reborn every few seconds (never more than 8).
 */
import type { Event2 } from "../analysis";
import { mixLinear, type ResolvedPalette, type RGB } from "../palette";
import { SpriteBatch, ihash, lerp, pickColor, rnd, smoothstep } from "./_particles";
import { Sprite } from "./_sprites";
import { eventsIn, triggerList } from "./_triggers";
import type { Motif } from "../types";

export interface MotifFrame {
  w: number;
  h: number;
  seed: number;
  tMs: number;
  /** Motion time in seconds, already scaled by the layer's speed. */
  t: number;
  amt: number;
  size: number;
  wind: number;
  density: number;
  /** h / 720: pixel sizes are authored at 720p. */
  sc: number;
  lvl: number;
  beat: number;
  kick: number;
  cum: number;
  draft: boolean;
  bright: number;
  palette: ResolvedPalette;
  tint: number;
  col: RGB;
  col2: RGB;
  /** Flash of lightning (0..1), also passed to the shader. */
  flash: number;
  analysis: import("../analysis").Analysis;
}

/** The natural colours of a motif (linear RGB), mixed with the palette by `tint`. */
export const NATURAL: Record<Motif, [RGB, RGB]> = {
  fire: [[1.0, 0.42, 0.08], [1.0, 0.8, 0.3]],
  rain: [[0.5, 0.7, 1.0], [0.7, 0.85, 1.0]],
  snow: [[0.9, 0.95, 1.0], [0.7, 0.85, 1.0]],
  stars: [[1.0, 0.95, 0.85], [0.5, 0.6, 1.0]],
  ocean: [[0.04, 0.45, 0.8], [0.7, 0.95, 1.0]],
  flowers: [[1.0, 0.38, 0.55], [1.0, 0.62, 0.74]],
  hearts: [[1.0, 0.18, 0.38], [1.0, 0.5, 0.6]],
  city: [[1.0, 0.65, 0.25], [0.3, 0.7, 1.0]],
  sun: [[1.0, 0.72, 0.25], [1.0, 0.45, 0.2]],
  night: [[0.55, 0.65, 1.0], [0.05, 0.07, 0.22]],
  storm: [[0.6, 0.72, 1.0], [0.8, 0.85, 1.0]],
  smoke: [[0.5, 0.52, 0.62], [0.8, 0.7, 0.9]],
};

export function tinted(natural: RGB, pal: ResolvedPalette, tint: number, k: number): RGB {
  return tint <= 0 ? natural : mixLinear(natural, pickColor(pal, "cycle", k * 4), tint);
}

/** Position in a repeating life: cycle number, age 0..1 and seconds. */
function life(t: number, periodS: number, phase: number): { cyc: number; q: number; age: number } {
  const u = t / periodS + phase;
  const cyc = Math.floor(u);
  const q = u - cyc;
  return { cyc, q, age: q * periodS };
}

const n = (m: MotifFrame, base: number): number => Math.max(0, Math.round(base * m.density * m.amt * (m.draft ? 0.55 : 1)));

function embersUp(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 130);
  for (let i = 0; i < cnt; i++) {
    const { cyc, q, age } = life(m.t, lerp(2.5, 5.5, rnd(m.seed, i, 1)), rnd(m.seed, i, 2));
    const r = (k: number) => rnd(m.seed, i, k + 10, cyc);
    const speed = lerp(0.07, 0.2, r(0)) * m.h * (0.8 + 0.7 * m.lvl);
    const x = m.w * (0.04 + 0.92 * r(1)) + Math.sin(age * (1 + r(2) * 2) + r(3) * 6.28) * m.w * 0.012 + m.wind * m.w * 0.05 * q;
    const y = m.h * (1.0 - 0.02 * r(4)) - speed * age;
    const rad = lerp(1.6, 4.2, r(5) * r(5)) * m.sc * m.size;
    const fl = 0.75 + 0.25 * Math.sin(age * (8 + r(6) * 9) + r(7) * 6);
    const a = smoothstep(0, 0.08, q) * (1 - smoothstep(0.45, 1, q)) * fl * 0.9;
    b.add(Sprite.ember, x, y, rad * 2.3, rad * 2.3, mixLinear(m.col2, m.col, q), a, 0, 0, 0.4 * (1 - q), m.bright * (1.0 + m.kick * 0.6));
  }
}

function rain(b: SpriteBatch, m: MotifFrame, heavy: number): void {
  const wind = m.wind * 0.5 + (heavy > 1 ? 0.35 : 0.08);
  const dx = wind / Math.hypot(wind, 1);
  const dy = 1 / Math.hypot(wind, 1);
  const rot = Math.atan2(dy, dx);
  const cnt = n(m, 260 * heavy);
  for (let i = 0; i < cnt; i++) {
    const d = rnd(m.seed, i, 0);
    const { cyc, q } = life(m.t, lerp(0.55, 0.95, 1 - d) / (0.7 + 0.5 * heavy), rnd(m.seed, i, 1));
    const x0 = m.w * (1.3 * rnd(m.seed, i, 2, cyc) - 0.15);
    const travel = (q * 1.25 - 0.12) * m.h;
    const hl = (16 + 46 * d) * m.sc * m.size;
    const rad = (0.55 + 0.9 * d) * m.sc * Math.sqrt(m.size);
    const hx = x0 + dx * travel;
    const hy = dy * travel;
    b.add(Sprite.streak, hx - dx * (hl - rad), hy - dy * (hl - rad), hl, rad, m.col, (0.14 + 0.36 * d) * smoothstep(0, 0.05, q) * (heavy > 1 ? 0.75 : 1), rot, 0, 0, m.bright * 1.3);
  }
  const sp = n(m, 70 * heavy);
  for (let i = 0; i < sp; i++) {
    const { cyc, q } = life(m.t, lerp(0.45, 0.8, rnd(m.seed, i, 20)), rnd(m.seed, i, 21));
    const x = m.w * rnd(m.seed, i, 22, cyc);
    const y = m.h * (0.84 + 0.14 * rnd(m.seed, i, 23, cyc));
    const rr = (4 + 20 * q) * m.sc * m.size * (0.5 + 0.5 * (y / m.h - 0.8) * 5);
    b.add(Sprite.ring, x, y, rr, rr * 0.28, m.col2, (1 - q) * (1 - q) * 0.45, 0, 0.09, 0, m.bright);
  }
}

function snow(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 240);
  for (let i = 0; i < cnt; i++) {
    const d = rnd(m.seed, i, 0);
    const { cyc, q, age } = life(m.t, lerp(5.5, 8, 1 - d * 0.6), rnd(m.seed, i, 1));
    const r = (k: number) => rnd(m.seed, i, k + 5, cyc);
    const x = m.w * (1.2 * r(0) - 0.1) + Math.sin(age * (0.7 + r(1)) + r(2) * 6.28) * m.w * 0.022 * (0.5 + d) + m.wind * m.w * 0.16 * q;
    const y = (q * 1.18 - 0.08) * m.h;
    const rot = r(3) * 6.28 + age * (r(4) - 0.5) * 1.6;
    const glint = 0.75 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(age * (3 + r(5) * 4) + r(6) * 6), 6);
    if (d > 0.93) b.add(Sprite.bokeh, x, y, (16 + 20 * r(7)) * m.sc * m.size, (16 + 20 * r(7)) * m.sc * m.size, m.col, 0.12, 0, 0.7, 0, m.bright, false);
    else if (d > 0.5) {
      const R = (4.5 + 7 * (d - 0.5)) * m.sc * m.size;
      b.add(Sprite.snowflake, x, y, R, R, m.col, 0.85 * glint, rot, 0, 0, m.bright * 1.2);
    } else {
      const R = (1.2 + 2.2 * d) * m.sc * m.size;
      b.add(Sprite.disc, x, y, R, R, m.col, (0.5 + 0.4 * d) * glint, 0, 0.5, 0, m.bright);
    }
  }
}

function stars(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 260);
  const theta = 0.004 * m.t + 0.01 * m.cum;
  const cx = m.w * 0.5;
  const cy = m.h * 1.4;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  for (let i = 0; i < cnt; i++) {
    const ox = m.w * (rnd(m.seed, i, 0) * 1.3 - 0.15) - cx;
    const oy = m.h * (rnd(m.seed, i, 1) * 1.1 - 0.2) - cy;
    const x = cx + ox * co - oy * si;
    const y = cy + ox * si + oy * co;
    if (y < -20 || y > m.h + 20) continue;
    const big = rnd(m.seed, i, 2) < 0.09;
    const tw = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(m.t * (0.8 + 2.6 * rnd(m.seed, i, 3)) + rnd(m.seed, i, 4) * 6.28), 2);
    const col = tinted(rnd(m.seed, i, 5) < 0.7 ? m.col : m.col2, m.palette, 0.3 * m.tint, rnd(m.seed, i, 6));
    if (big) {
      const R = lerp(7, 16, rnd(m.seed, i, 7)) * m.sc * m.size;
      b.add(Sprite.star, x, y, R, R, col, tw * 0.95, 0, 0, 0, m.bright * 1.5);
    } else {
      const R = lerp(0.8, 1.7, rnd(m.seed, i, 7)) * m.sc * m.size;
      b.add(Sprite.disc, x, y, R, R, col, tw * 0.9, 0, 0.5, 0, m.bright * 1.3);
    }
  }
  // Two shooting stars, each crossing the sky for 0.8 s every 8 to 13 s.
  for (let i = 0; i < 2; i++) {
    const { cyc, age } = life(m.t, 8 + 5 * rnd(m.seed, i, 40), rnd(m.seed, i, 41));
    const dur = 0.85;
    if (age > dur || m.amt < 0.15) continue;
    const u = age / dur;
    const x0 = m.w * (0.45 + 0.5 * rnd(m.seed, i, 42, cyc));
    const y0 = m.h * (0.04 + 0.28 * rnd(m.seed, i, 43, cyc));
    const dx = -0.82;
    const dy = 0.57;
    const trav = m.w * 0.5 * (1 - Math.pow(1 - u, 2));
    const hl = m.w * 0.07 * m.size;
    const rad = 1.7 * m.sc;
    b.add(Sprite.streak, x0 + dx * (trav - (hl - rad)), y0 + dy * (trav - (hl - rad)), hl, rad, m.col, Math.sin(Math.PI * u) * 0.95, Math.atan2(dy, dx), 0, 0, m.bright * 2.2);
  }
}

function petals(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 100);
  const pal: RGB[] = [m.col, m.col2, mixLinear(m.col, [1, 0.12, 0.3], 0.45)];
  for (let i = 0; i < cnt; i++) {
    const d = rnd(m.seed, i, 0);
    const { cyc, q, age } = life(m.t, lerp(6, 8, 1 - d * 0.5), rnd(m.seed, i, 1));
    const r = (k: number) => rnd(m.seed, i, k + 5, cyc);
    const x = m.w * (1.2 * r(0) - 0.1) + Math.sin(age * (0.6 + r(1) * 0.8) + r(2) * 6.28) * m.w * 0.05 * (0.5 + d) + m.wind * m.w * 0.22 * q + Math.sin(age * 1.9 + r(3) * 6) * m.w * 0.008;
    const y = (q * 1.2 - 0.1) * m.h;
    const len = lerp(9, 19, d) * m.sc * m.size;
    const flutter = 0.28 + 0.72 * Math.abs(Math.cos(age * (1.3 + r(4) * 1.5) + r(5) * 6));
    const rot = r(6) * 6.28 + age * (r(7) - 0.5) * 2.2 + Math.sin(age * 1.6 + r(8) * 6) * 0.6;
    const col = pal[Math.floor(r(9) * pal.length) % pal.length] as RGB;
    b.add(Sprite.petal, x, y, len, len * 0.55 * flutter, col, 0.92 * smoothstep(0, 0.05, q) * (1 - smoothstep(0.92, 1, q)), rot, 0, flutter, m.bright * 0.7);
  }
  // A few drifting pollen lights.
  const pol = n(m, 26);
  for (let i = 0; i < pol; i++) {
    const { q, age } = life(m.t * 0.6, 7, rnd(m.seed, i, 60));
    const x = m.w * rnd(m.seed, i, 61) + Math.sin(age + i) * m.w * 0.03;
    const y = (1 - q) * m.h * 1.1 - m.h * 0.05;
    const R = lerp(2, 6, rnd(m.seed, i, 62)) * m.sc * m.size;
    b.add(Sprite.ember, x, y, R * 2.4, R * 2.4, m.col2, 0.5 * Math.sin(Math.PI * q), 0, 0, 0.4, m.bright);
  }
}

function hearts(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 44);
  for (let i = 0; i < cnt; i++) {
    const d = rnd(m.seed, i, 0); // 0 far/small .. 1 near/large + blurred
    const { cyc, q, age } = life(m.t, lerp(6.5, 8, 1 - d * 0.6), rnd(m.seed, i, 1));
    const r = (k: number) => rnd(m.seed, i, k + 5, cyc);
    const R = lerp(9, 44, Math.pow(d, 1.5)) * m.sc * m.size * (1 + 0.12 * m.beat);
    const x = m.w * (1.1 * r(0) - 0.05) + Math.sin(age * (0.5 + r(1) * 0.7) + r(2) * 6.28) * m.w * 0.03 * (0.4 + d) + m.wind * m.w * 0.06 * q;
    const y = (1.08 - q * 1.2) * m.h;
    const col = mixLinear(m.col, m.col2, r(3));
    const soft = d > 0.7 ? 0.4 + 0.5 * (d - 0.7) / 0.3 : d < 0.25 ? 0.1 : 0;
    const a = (d > 0.7 ? 0.38 : 0.55 + 0.35 * d) * smoothstep(0, 0.1, q) * (1 - smoothstep(0.7, 1, q));
    b.add(Sprite.heart, x, y, R, R, col, a, Math.sin(age * 1.1 + r(4) * 6) * 0.22, soft, 0, m.bright * 0.85);
  }
}

const CITY: RGB[] = [[1.0, 0.68, 0.28], [1.0, 0.92, 0.78], [0.3, 0.75, 1.0], [1.0, 0.3, 0.65], [1.0, 0.8, 0.4], [1.0, 0.22, 0.15]];

function city(b: SpriteBatch, m: MotifFrame): void {
  const cnt = n(m, 56);
  for (let i = 0; i < cnt; i++) {
    const d = rnd(m.seed, i, 0);
    const x = m.w * (rnd(m.seed, i, 1) * 1.1 - 0.05) + Math.sin(m.t * 0.15 + i) * m.w * 0.006 * (0.3 + d);
    const y = m.h * lerp(0.3, 0.9, Math.pow(rnd(m.seed, i, 2), 0.9));
    const R = lerp(6, 40, Math.pow(d, 1.7)) * m.sc * m.size;
    const tw = 0.55 + 0.45 * Math.sin(m.t * (0.4 + rnd(m.seed, i, 3) * 1.4) + rnd(m.seed, i, 4) * 6.28);
    const idx = Math.floor(rnd(m.seed, i, 5) * 6);
    const base = CITY[idx % CITY.length] as RGB;
    const col = tinted(idx % 2 === 0 ? mixLinear(base, m.col, 0.5) : base, m.palette, m.tint * 0.6, rnd(m.seed, i, 6));
    b.add(Sprite.bokeh, x, y, R, R, col, (0.26 + 0.4 * (1 - d)) * tw * (0.8 + 0.5 * m.kick * 0.5), 0, 0.12 + 0.4 * d, 0, m.bright * 1.4, false);
  }
  // Lit windows of a skyline along the bottom.
  const blds = 13;
  const dens = Math.min(1, m.density) * m.amt;
  for (let bI = 0; bI < blds; bI++) {
    const bx = (bI + 0.15 + 0.5 * rnd(m.seed, bI, 80)) * (m.w / blds);
    const bw = m.w * lerp(0.04, 0.07, rnd(m.seed, bI, 81));
    const bh = m.h * lerp(0.1, 0.36, Math.pow(rnd(m.seed, bI, 82), 1.3)) * m.size;
    const cols = Math.max(2, Math.round(bw / (11 * m.sc)));
    const rows = Math.max(2, Math.round(bh / (13 * m.sc)));
    for (let rI = 0; rI < rows; rI++) {
      for (let cI = 0; cI < cols; cI++) {
        if (rnd(m.seed, bI * 97 + rI * 13 + cI, 83) > 0.42 * dens) continue;
        const x = bx + ((cI + 0.5) / cols - 0.5) * bw;
        const y = m.h * 0.995 - ((rI + 0.5) / rows) * bh;
        const tw = 0.65 + 0.35 * Math.sin(m.t * (0.2 + rnd(m.seed, bI * 97 + rI * 13 + cI, 84) * 0.6) + cI + rI);
        const cool = rnd(m.seed, bI * 97 + rI * 13 + cI, 85) < 0.18;
        b.add(Sprite.disc, x, y, 1.9 * m.sc, 2.4 * m.sc, cool ? m.col2 : m.col, 0.8 * tw, 0, 0.3, 0, m.bright * 1.5, false);
      }
    }
  }
  // Cars: headlights one way, tail lights the other.
  const cars = n(m, 14);
  for (let i = 0; i < cars; i++) {
    const dirR = i % 2 === 0;
    const { cyc, q } = life(m.t, lerp(3.5, 7, rnd(m.seed, i, 70)), rnd(m.seed, i, 71));
    const y = m.h * (dirR ? 0.9 : 0.95) + (rnd(m.seed, i, 72, cyc) - 0.5) * m.h * 0.015;
    const x = (dirR ? q : 1 - q) * m.w * 1.3 - m.w * 0.15;
    const hl = m.w * lerp(0.03, 0.07, rnd(m.seed, i, 73, cyc)) * m.size;
    const col: RGB = dirR ? [1.0, 0.9, 0.7] : [1.0, 0.15, 0.1];
    b.add(Sprite.streak, x - (dirR ? hl * 0.9 : -hl * 0.9), y, hl, 2.2 * m.sc, col, 0.85 * Math.sin(Math.PI * q), dirR ? 0 : Math.PI, 0, 0, m.bright * 1.5);
  }
}

/** Lightning from snares: a jagged main bolt with two branches, drawn as glowing segments. */
function lightning(b: SpriteBatch, m: MotifFrame, rate: number): number {
  let list = triggerList(m.analysis, "snare");
  if (list.length === 0) list = triggerList(m.analysis, "downbeat");
  const evs = eventsIn(list, m.tMs - 900, m.tMs) as Event2[];
  let flash = 0;
  for (const e of evs) {
    const key = Math.round(e[0]);
    if (ihash(m.seed, key, 91) > rate * (0.5 + 0.5 * m.amt)) continue;
    const age = (m.tMs - e[0]) / 1000;
    const env = Math.exp(-age / 0.07) + (age > 0.12 ? 0.65 * Math.exp(-(age - 0.12) / 0.14) : 0);
    flash = Math.max(flash, Math.min(1, env) * (0.55 + 0.45 * (e[1] / 255)));
    if (age > 0.5) continue;
    const alpha = Math.min(1, env) * (0.6 + 0.4 * Math.sin(age * 90)) * m.amt;
    const x0 = m.w * (0.15 + 0.7 * rnd(m.seed, key, 1));
    const segs = 15;
    const pts: Array<[number, number]> = [[x0, -10]];
    let cx = x0;
    const lean = (rnd(m.seed, key, 2) - 0.5) * 0.9;
    for (let s = 1; s <= segs; s++) {
      cx += (rnd(m.seed, key, 10 + s) - 0.5 + lean * 0.35) * m.w * 0.07;
      pts.push([cx, (s / segs) * m.h * (0.62 + 0.2 * rnd(m.seed, key, 3))]);
    }
    const draw = (p: Array<[number, number]>, thick: number, al: number) => {
      for (let s = 1; s < p.length; s++) {
        const a0 = p[s - 1] as [number, number];
        const a1 = p[s] as [number, number];
        const len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
        const rad = thick * m.sc;
        b.add(Sprite.bolt, (a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, len / 2 + rad * 0.4, rad, m.col2, al, Math.atan2(a1[1] - a0[1], a1[0] - a0[0]), 0, 0, m.bright * 3.6);
      }
    };
    draw(pts, 2.8, alpha);
    for (let br = 0; br < 2; br++) {
      const from = 4 + Math.floor(rnd(m.seed, key, 30 + br) * 6);
      const start = pts[from] as [number, number];
      const side = rnd(m.seed, key, 32 + br) < 0.5 ? -1 : 1;
      const bp: Array<[number, number]> = [start];
      let bx = start[0];
      let by = start[1];
      for (let s = 0; s < 6; s++) {
        bx += (side * 0.5 + (rnd(m.seed, key, 40 + br * 8 + s) - 0.5)) * m.w * 0.05;
        by += m.h * 0.045;
        bp.push([bx, by]);
      }
      draw(bp, 1.6, alpha * 0.75);
    }
  }
  return flash;
}

/** Draws the particle part of a motif; returns the lightning flash (0 otherwise). */
export function drawMotifParticles(motif: Motif, b: SpriteBatch, m: MotifFrame): number {
  switch (motif) {
    case "fire":
      embersUp(b, m);
      break;
    case "rain":
      rain(b, m, 1);
      break;
    case "storm":
      rain(b, m, 1.1);
      return lightning(b, m, 0.55);
    case "snow":
      snow(b, m);
      break;
    case "stars":
    case "night":
      stars(b, m);
      break;
    case "flowers":
      petals(b, m);
      break;
    case "hearts":
      hearts(b, m);
      break;
    case "city":
      city(b, m);
      break;
    default:
      break;
  }
  return 0;
}
