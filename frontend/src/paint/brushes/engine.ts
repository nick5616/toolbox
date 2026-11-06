// The brush engine: turns input points into dabs for a BrushPreset (SPEC
// §1.3.1). Pure and deterministic: points + preset + seed → the same dabs.
// The GPU/CPU backends rasterise the dabs; this file never touches pixels.

import { D, DAB_STRIDE } from "../engine/gl";
import type { InputPoint, RGBA } from "../engine/types";
import { copyCount, isMirrored, mapPoint, type SymmetryConfig } from "../guides/symmetry";
import { Smoother, newSample, type Sample } from "../input/smoothing";
import { bakeCurve, type CurveLUT } from "./curve";
import { mixSeed } from "./rng";
import type { BrushPreset, DynamicsInput, DynamicsTarget } from "./schema";

/** Extra per-dab fields beyond gl.ts's D (not read by the backends). */
export const DAB_DIST = 16; // path distance of the dab along its copy
export const DAB_COPY = 17; // symmetry copy index
export const DAB_BASE_SIZE = 18; // size before the end taper
export const DAB_BASE_ALPHA = 19; // alpha before the end taper

export class DabList {
  data = new Float32Array(DAB_STRIDE * 256);
  count = 0;

  /** Offset of a fresh dab (zeroed). Grows by doubling; the only allocation on the stroke path. */
  push(): number {
    const need = (this.count + 1) * DAB_STRIDE;
    if (need > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const o = this.count * DAB_STRIDE;
    this.data.fill(0, o, o + DAB_STRIDE);
    this.count++;
    return o;
  }

  clear(): void {
    this.count = 0;
  }
}

class RngState {
  a = 0;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

interface Dyn {
  input: number; // 0 pressure, 1 tilt, 2 velocity, 3 progress
  target: DynamicsTarget;
  amount: number;
  lut: CurveLUT;
}

const INPUT_INDEX: Record<DynamicsInput, number> = { pressure: 0, tilt: 1, velocity: 2, progress: 3 };

class Walker {
  has = false;
  px = 0;
  py = 0;
  pressure = 0;
  tiltX = 0;
  tiltY = 0;
  twist = 0;
  t = 0;
  speed = 0;
  nextAt = 0;
  dist = 0; // distance at (px, py)
  rng: RngState;
  constructor(seed: number) {
    this.rng = new RngState(seed);
  }
  copyFrom(o: Walker): void {
    this.has = o.has;
    this.px = o.px;
    this.py = o.py;
    this.pressure = o.pressure;
    this.tiltX = o.tiltX;
    this.tiltY = o.tiltY;
    this.twist = o.twist;
    this.t = o.t;
    this.speed = o.speed;
    this.nextAt = o.nextAt;
    this.dist = o.dist;
    this.rng.a = o.rng.a;
  }
}

export interface StrokeConfig {
  preset: BrushPreset;
  color: RGBA;
  secondary: RGBA;
  seed: number;
  symmetry: SymmetryConfig;
}

function rgbToHsv(r: number, g: number, b: number, out: number[]): void {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  out[0] = h;
  out[1] = mx === 0 ? 0 : d / mx;
  out[2] = mx;
}

function hsvToRgb(h: number, s: number, v: number, out: number[]): void {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      out[0] = v; out[1] = t; out[2] = p; break;
    case 1:
      out[0] = q; out[1] = v; out[2] = p; break;
    case 2:
      out[0] = p; out[1] = v; out[2] = t; break;
    case 3:
      out[0] = p; out[1] = q; out[2] = v; break;
    case 4:
      out[0] = t; out[1] = p; out[2] = v; break;
    default:
      out[0] = v; out[1] = p; out[2] = q;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class StrokeRenderer {
  readonly dabs = new DabList();
  readonly preset: BrushPreset;
  private readonly cfg: StrokeConfig;
  private readonly smoother: Smoother;
  private readonly walkers: Walker[] = [];
  private readonly copies: number;
  private readonly dyn: Dyn[] = [];
  private readonly hasSizeDyn: boolean;
  private readonly cur = newSample();
  private readonly tmp = newSample();
  private readonly mapped = { x: 0, y: 0 };
  private readonly inputs = new Float64Array(4);
  private readonly c3: number[] = [0, 0, 0];
  private readonly hsv: number[] = [0, 0, 0];
  private strokeJitter: [number, number, number] = [0, 0, 0];
  private readonly progressLen: number;
  private twin: StrokeRenderer | null = null;
  private pixel: boolean;
  /** The raw points fed in (for QuickShape and replays). */
  readonly raw: InputPoint[] = [];
  private finished = false;

  constructor(cfg: StrokeConfig) {
    this.cfg = cfg;
    this.preset = cfg.preset;
    this.smoother = new Smoother(cfg.preset.smoothing);
    this.copies = copyCount(cfg.symmetry);
    for (let k = 0; k < this.copies; k++) this.walkers.push(new Walker(mixSeed(cfg.seed, k)));
    let hasSize = false;
    for (const d of cfg.preset.dynamics) {
      this.dyn.push({ input: INPUT_INDEX[d.input] ?? 0, target: d.target, amount: d.amount, lut: bakeCurve(d.curve) });
      if (d.target === "size") hasSize = true;
    }
    this.hasSizeDyn = hasSize;
    this.progressLen = Math.max(150, cfg.preset.size * 12);
    this.pixel = !cfg.preset.antialias;
    // Stroke-level colour jitter draws from a stream of its own.
    const r = new RngState(mixSeed(cfg.seed, 9999));
    this.strokeJitter = [r.next(), r.next(), r.next()];
  }

  /** Total path length of copy 0. */
  get length(): number {
    return (this.walkers[0] as Walker).dist;
  }

  begin(p: InputPoint): void {
    this.raw.push(p);
    this.smoother.push(p, this.onSample);
  }

  add(points: InputPoint[]): void {
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as InputPoint;
      this.raw.push(p);
      this.smoother.push(p, this.onSample);
    }
  }

  /**
   * End of stroke: let the smoothing lag catch up, then apply the end taper.
   * Returns true when earlier dabs changed (the caller redraws the scratch).
   */
  finish(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.smoother.flush(this.onSample);
    const t = this.preset.taper;
    if (t.end <= 0) return false;
    const f = this.dabs.data;
    let changed = false;
    for (let n = 0; n < this.dabs.count; n++) {
      const o = n * DAB_STRIDE;
      const total = (this.walkers[f[o + DAB_COPY] as number] as Walker).dist;
      const endLen = Math.max(1, t.end * (f[o + DAB_BASE_SIZE] as number) * 10);
      const left = total - (f[o + DAB_DIST] as number);
      if (left >= endLen) continue;
      const ramp = 0.02 + 0.98 * smooth(clamp01(left / endLen));
      f[o + D.SIZE] = (f[o + DAB_BASE_SIZE] as number) * ramp;
      if (t.byPressure) f[o + D.ALPHA] = (f[o + DAB_BASE_ALPHA] as number) * ramp;
      changed = true;
    }
    return changed;
  }

  /** The dabs a predicted tail would add, without changing this stroke. Output is `out`. */
  preview(points: InputPoint[], out: DabList): void {
    out.clear();
    if (this.finished || points.length === 0) return;
    const tw = this.twin ?? (this.twin = new StrokeRenderer(this.cfg));
    tw.smoother.copyFrom(this.smoother);
    for (let k = 0; k < this.walkers.length; k++) (tw.walkers[k] as Walker).copyFrom(this.walkers[k] as Walker);
    tw.strokeJitter = this.strokeJitter;
    tw.dabs.clear();
    for (let i = 0; i < points.length; i++) tw.smoother.push(points[i] as InputPoint, tw.onSample);
    const f = tw.dabs.data;
    for (let n = 0; n < tw.dabs.count; n++) {
      const o = out.push();
      out.data.set(f.subarray(n * DAB_STRIDE, (n + 1) * DAB_STRIDE), o);
    }
  }

  private readonly onSample = (s: Sample): void => {
    const cur = this.cur;
    for (let k = 0; k < this.copies; k++) {
      mapPoint(this.cfg.symmetry, k, s.x, s.y, this.mapped);
      cur.x = this.mapped.x;
      cur.y = this.mapped.y;
      cur.pressure = s.pressure;
      cur.tiltX = isMirrored(this.cfg.symmetry, k) ? -s.tiltX : s.tiltX;
      cur.tiltY = s.tiltY;
      cur.twist = s.twist;
      cur.t = s.t;
      cur.speed = s.speed;
      this.advance(this.walkers[k] as Walker, cur, k);
    }
  };

  private advance(w: Walker, cur: Sample, k: number): void {
    if (!w.has) {
      w.has = true;
      this.setPrev(w, cur);
      const step = this.emit(w, cur, 0, 1, 0, k);
      w.nextAt = step;
      return;
    }
    const dx = cur.x - w.px;
    const dy = cur.y - w.py;
    const seg = Math.hypot(dx, dy);
    if (seg < 1e-6) {
      w.pressure = cur.pressure;
      return;
    }
    const ux = dx / seg;
    const uy = dy / seg;
    const t = this.tmp;
    let d = w.nextAt;
    while (d <= seg) {
      const f = d / seg;
      t.x = w.px + dx * f;
      t.y = w.py + dy * f;
      t.pressure = w.pressure + (cur.pressure - w.pressure) * f;
      t.tiltX = w.tiltX + (cur.tiltX - w.tiltX) * f;
      t.tiltY = w.tiltY + (cur.tiltY - w.tiltY) * f;
      t.twist = w.twist + (cur.twist - w.twist) * f;
      t.t = w.t + (cur.t - w.t) * f;
      t.speed = w.speed + (cur.speed - w.speed) * f;
      d += this.emit(w, t, w.dist + d, ux, uy, k);
    }
    w.nextAt = d - seg;
    w.dist += seg;
    this.setPrev(w, cur);
  }

  private setPrev(w: Walker, s: Sample): void {
    w.px = s.x;
    w.py = s.y;
    w.pressure = s.pressure;
    w.tiltX = s.tiltX;
    w.tiltY = s.tiltY;
    w.twist = s.twist;
    w.t = s.t;
    w.speed = s.speed;
  }

  /** Write the dab(s) for a sample; returns the distance to the next step. */
  private emit(w: Walker, s: Sample, dist: number, ux: number, uy: number, k: number): number {
    const p = this.preset;
    const inp = this.inputs;
    inp[0] = clamp01(s.pressure);
    inp[1] = clamp01(Math.max(Math.abs(s.tiltX), Math.abs(s.tiltY)) / 90);
    inp[2] = clamp01(s.speed / 4);
    inp[3] = clamp01(dist / this.progressLen);
    let sizeF = 1;
    let alphaF = 1;
    let flowF = 1;
    let scatterAdd = 0;
    let hueShift = 0;
    for (let i = 0; i < this.dyn.length; i++) {
      const d = this.dyn[i] as Dyn;
      const v = d.lut.at(inp[d.input] as number);
      const f = 1 - d.amount * (1 - v);
      switch (d.target) {
        case "size":
          sizeF *= f;
          break;
        case "opacity":
          alphaF *= f;
          break;
        case "flow":
          flowF *= f;
          break;
        case "scatter":
          scatterAdd += d.amount * v;
          break;
        case "hue":
          hueShift += d.amount * v;
          break;
      }
    }
    if (!this.hasSizeDyn) sizeF = inp[0] as number;
    // Taper in: a ramp over the first stretch of the stroke.
    let taperF = 1;
    if (p.taper.start > 0) {
      const len = Math.max(1, p.taper.start * p.size * 10);
      taperF = 0.02 + 0.98 * smooth(clamp01(dist / len));
    }
    let size = p.size * (p.minSize + (1 - p.minSize) * sizeF);
    let flow = p.flow * flowF * alphaF * this.cfg.color.a;
    if (p.taper.byPressure) flow *= taperF;
    else size *= taperF;
    if (this.pixel) size = Math.max(1, Math.round(size));
    else size = Math.max(0.4, size);
    // Wet.
    const wet = p.wet;
    let wetMix = 0;
    let pullX = 0;
    let pullY = 0;
    if (wet.mix > 0) {
      const ramp = 1 - wet.grade + wet.grade * clamp01(inp[3] as number * 2);
      wetMix = clamp01(wet.mix * ramp + wet.dilution * 0.3);
      flow *= 1 - 0.5 * wet.dilution;
      flow *= 1 - (1 - wet.charge) * 0.8 * (inp[3] as number);
      pullX = -ux * wet.pull * size * 0.5;
      pullY = -uy * wet.pull * size * 0.5;
    }
    const rng = w.rng;
    const spacing = Math.max(this.pixel ? 1 : 0.5, p.spacing * size);
    const count = Math.max(1, Math.min(16, Math.round(p.count)));
    const scatter = (p.scatter + scatterAdd) * size;
    const sec = this.cfg.secondary;
    const col = this.cfg.color;
    const tipAngle = (p.tip.angle * Math.PI) / 180;
    let base = tipAngle;
    if (p.tip.angleMode === "stroke") base += Math.atan2(uy, ux);
    else if (p.tip.angleMode === "tilt" && (s.tiltX !== 0 || s.tiltY !== 0)) base += Math.atan2(s.tiltY, s.tiltX);
    const dualAngle = p.dual ? (p.dual.angle * Math.PI) / 180 : 0;
    const mix = p.color.secondaryMix * (1 - clamp01(s.pressure));
    const cr = col.r + (sec.r - col.r) * mix;
    const cg = col.g + (sec.g - col.g) * mix;
    const cb = col.b + (sec.b - col.b) * mix;
    const cd = p.color;
    const jittery = cd.hueJitter > 0 || cd.satJitter > 0 || cd.briJitter > 0 || hueShift !== 0;
    for (let c = 0; c < count; c++) {
      const o = this.dabs.push();
      const f = this.dabs.data;
      // A fixed number of draws per dab keeps the sequence stable.
      const r0 = rng.next();
      const r1 = rng.next();
      const r2 = rng.next();
      const r3 = rng.next();
      const r4 = rng.next();
      const r5 = rng.next();
      const r6 = rng.next();
      const r7 = rng.next();
      const r8 = rng.next();
      let x = s.x;
      let y = s.y;
      if (scatter > 0) {
        x += (r0 - 0.5) * 2 * scatter;
        y += (r1 - 0.5) * 2 * scatter;
      }
      if (this.pixel) {
        x = Math.floor(x) + 0.5;
        y = Math.floor(y) + 0.5;
      }
      f[o + D.X] = x;
      f[o + D.Y] = y;
      f[o + D.SIZE] = size;
      f[o + D.ANGLE] = base + (r2 - 0.5) * 2 * Math.PI * p.tip.rotationJitter;
      f[o + D.ROUND] = Math.max(0.05, p.tip.roundness);
      f[o + D.ALPHA] = clamp01(flow);
      let r = cr;
      let g = cg;
      let b = cb;
      if (jittery) {
        rgbToHsv(r, g, b, this.hsv);
        const j = cd.perStroke ? this.strokeJitter : [r3, r4, r5];
        const h = (this.hsv[0] as number) + ((j[0] as number) - 0.5) * cd.hueJitter + hueShift;
        const sa = clamp01((this.hsv[1] as number) + ((j[1] as number) - 0.5) * 2 * cd.satJitter);
        const v = clamp01((this.hsv[2] as number) + ((j[2] as number) - 0.5) * 2 * cd.briJitter);
        hsvToRgb(h, sa, v, this.c3);
        r = this.c3[0] as number;
        g = this.c3[1] as number;
        b = this.c3[2] as number;
      }
      f[o + D.R] = r;
      f[o + D.G] = g;
      f[o + D.B] = b;
      f[o + D.GX] = r6 * 4096;
      f[o + D.GY] = r7 * 4096;
      f[o + D.DANGLE] = dualAngle + (r8 - 0.5) * 2 * Math.PI * (p.dual ? p.dual.rotationJitter : 0);
      f[o + D.DSCALE] = 1;
      f[o + D.WET] = wetMix;
      f[o + D.PULLX] = pullX;
      f[o + D.PULLY] = pullY;
      f[o + DAB_DIST] = dist;
      f[o + DAB_COPY] = k;
      f[o + DAB_BASE_SIZE] = size;
      f[o + DAB_BASE_ALPHA] = clamp01(flow);
    }
    return spacing;
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);
