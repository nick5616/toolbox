/**
 * Reference maths of the colour ops (Phase 21 §E3.1): pure functions over packed rows (grade/pack.ts), the
 * same numbers the `gradelook` shader reads. The GLSL in viz/post/gradelook.ts mirrors these line by line;
 * tests compare them (vectors, identities, the LUT lattice) and the CPU LUT fallback runs them.
 *
 * Colours are sRGB-encoded 0..1 floats (the pass converts from the engine's linear light and back), every op
 * clamps to 0..1, and amount/region/pulse blend as `mix(prev, op(prev), amount × region × pulse)`.
 */
import type { Vec3 } from "./color";
import { KIND_CODE, REGION_CODE, ROW_FLOATS } from "./pack";

export type { Vec3 };

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
}
export const luma = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const map3 = (c: Vec3, f: (x: number, i: number) => number): Vec3 => [f(c[0], 0), f(c[1], 1), f(c[2], 2)];
const clampC = (c: Vec3): Vec3 => map3(c, clamp01);
const fract = (x: number): number => x - Math.floor(x);

export const toLin = (x: number): number => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
export const toSrgb = (x: number): number => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** The per-pixel inputs an op may read besides its colour. */
export interface PixelCtx {
  /** Frame position, y up (0..1). */
  x: number;
  y: number;
  /** Frame size in px (for grain). */
  w: number;
  h: number;
  /** Maps, 0..1; defaults are the contract's constants (depth 0.5, subject 1). */
  depth: number;
  subject: number;
  people: number;
  /** Seconds (the frame's time). */
  t: number;
  /** The numeric params d0..d15. */
  drive: readonly number[];
}

export const defaultPixel = (over: Partial<PixelCtx> = {}): PixelCtx => ({ x: 0.5, y: 0.5, w: 64, h: 64, depth: 0.5, subject: 1, people: 1, t: 0, drive: new Array<number>(16).fill(1), ...over });

// ---- row access ----

const P0 = 12;
/** Float j of the param texel i of a row. */
const f = (row: Float32Array, base: number, i: number, j: number): number => row[base + P0 + i * 4 + j] as number;

// ---- colour spaces ----

export function rgbToHsv(c: Vec3): Vec3 {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === c[0]) h = ((c[1] - c[2]) / d + 6) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
  }
  return [h * 60, mx > 1e-9 ? d / mx : 0, mx];
}

export function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const hh = (((h % 360) + 360) % 360) / 60;
  const k = (n: number) => (n + hh) % 6;
  const ch = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [ch(5), ch(3), ch(1)];
}

/** sRGB (0..1) → Lab (D65). */
export function rgbToLab(c: Vec3): Vec3 {
  const r = toLin(c[0]);
  const g = toLin(c[1]);
  const b = toLin(c[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fn = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = fn(x);
  const fy = fn(y);
  const fz = fn(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(lab: Vec3): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const inv = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return clampC([toSrgb(clamp01(r)), toSrgb(clamp01(g)), toSrgb(clamp01(b))]);
}

/** Lab mean and standard deviation per tonal band (shadows, mids, highlights) of RGBA bytes: 18 numbers, as GradeService.Transfer. */
export function labBandStats(rgba: ArrayLike<number>, step = 1): number[] {
  const sum = Array.from({ length: 3 }, () => [0, 0, 0]);
  const sq = Array.from({ length: 3 }, () => [0, 0, 0]);
  const wt = [0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4 * step) {
    if ((rgba[i + 3] as number) < 8) continue;
    const lab = rgbToLab([(rgba[i] as number) / 255, (rgba[i + 1] as number) / 255, (rgba[i + 2] as number) / 255]);
    const w = bandWeights(lab[0] / 100);
    for (let b = 0; b < 3; b++) {
      const wb = w[b] as number;
      wt[b] = (wt[b] as number) + wb;
      for (let k = 0; k < 3; k++) {
        const v = lab[k] as number;
        (sum[b] as number[])[k] = ((sum[b] as number[])[k] as number) + wb * v;
        (sq[b] as number[])[k] = ((sq[b] as number[])[k] as number) + wb * v * v;
      }
    }
  }
  const out: number[] = [];
  for (let b = 0; b < 3; b++) {
    const n = Math.max(1e-6, wt[b] as number);
    const mean = (sum[b] as number[]).map((s) => s / n);
    const sd = (sq[b] as number[]).map((s, k) => Math.sqrt(Math.max(0, s / n - (mean[k] as number) ** 2)));
    out.push(...mean, ...sd);
  }
  return out;
}

/** Soft weights of the shadows, mids and highlights bands at lightness l (0..1); they sum to 1. */
export function bandWeights(l: number): [number, number, number] {
  const ws = 1 - smoothstep(0.2, 0.5, l);
  const wh = smoothstep(0.5, 0.8, l);
  return [ws, Math.max(0, 1 - ws - wh), wh];
}

// ---- curves ----

/** Monotone cubic (Steffen tangents) through y at x = 0, .25, .5, .75, 1. */
export function curve5(y: readonly number[], x: number): number {
  const h = 0.25;
  const d: number[] = [];
  for (let i = 0; i < 4; i++) d.push(((y[i + 1] as number) - (y[i] as number)) / h);
  const m: number[] = [d[0] as number];
  for (let i = 1; i < 4; i++) {
    const a = d[i - 1] as number;
    const b = d[i] as number;
    m.push(a * b <= 0 ? 0 : (2 * a * b) / (a + b));
  }
  m.push(d[3] as number);
  const xx = clamp01(x) * 4;
  const s = Math.min(3, Math.floor(xx));
  const t = xx - s;
  const t2 = t * t;
  const t3 = t2 * t;
  return clamp01(
    (2 * t3 - 3 * t2 + 1) * (y[s] as number) + (t3 - 2 * t2 + t) * h * (m[s] as number) + (-2 * t3 + 3 * t2) * (y[s + 1] as number) + (t3 - t2) * h * (m[s + 1] as number),
  );
}

// ---- gradient ----

export function gradientAt(row: Float32Array, base: number, t: number): Vec3 {
  const n = Math.max(1, Math.min(8, Math.round(f(row, base, 0, 0))));
  const stop = (i: number): [Vec3, number] => [[f(row, base, 1 + i, 0), f(row, base, 1 + i, 1), f(row, base, 1 + i, 2)], f(row, base, 1 + i, 3)];
  let [col, pos] = stop(0);
  if (t <= pos) return col;
  for (let i = 1; i < n; i++) {
    const [c1, p1] = stop(i);
    if (t <= p1) return mix3(col, c1, (t - pos) / Math.max(1e-6, p1 - pos));
    col = c1;
    pos = p1;
  }
  return col;
}

// ---- animation, regions ----

/** The pulse multiplier of a row at time t (1 when there is no pulse). Drift kinds (gradmap, huecycle) never pulse. */
export function pulseOf(row: Float32Array, base: number, px: PixelCtx, index: number): number {
  const wave = row[base + 6] as number;
  if (wave === 0) return 1;
  const kind = row[base] as number;
  if (kind === KIND_CODE.gradmap || kind === KIND_CODE.huecycle) return 1;
  const depth = row[base + 8] as number;
  const cyc = ((row[base + 7] as number) * px.t) / 10;
  let w = 1;
  if (wave === 1) w = 0.5 + 0.5 * Math.cos(2 * Math.PI * cyc);
  else if (wave === 2) w = 1 - fract(cyc);
  else w = clamp01(px.drive[index] ?? 1);
  return 1 - depth + depth * w;
}

/** How far a drift kind has moved (in cycles of its gradient or hue wheel). */
export function driftOf(row: Float32Array, base: number, px: PixelCtx, index: number): number {
  const wave = row[base + 6] as number;
  if (wave === 0) return 0;
  if (wave === 3) return 0.25 * clamp01(px.drive[index] ?? 0);
  return ((row[base + 7] as number) * px.t) / 10;
}

export function regionWeight(row: Float32Array, base: number, l0: number, px: PixelCtx): number {
  const code = row[base + 2] as number;
  if (code === REGION_CODE.all) return 1;
  const sp = row[base + 4] as number; // soft or feather
  const split = row[base + 5] as number;
  let w = 1;
  switch (code) {
    case REGION_CODE.highlights:
    case REGION_CODE.shadows:
    case REGION_CODE.midtones: {
      const hw = 0.05 + 0.3 * sp;
      const hi = smoothstep(0.6 - hw, 0.6 + hw, l0);
      const sh = 1 - smoothstep(0.4 - hw, 0.4 + hw, l0);
      w = code === REGION_CODE.highlights ? hi : code === REGION_CODE.shadows ? sh : (1 - hi) * (1 - sh);
      break;
    }
    case REGION_CODE.subject:
    case REGION_CODE.background:
    case REGION_CODE.people: {
      const hf = 0.02 + 0.48 * sp;
      const m = code === REGION_CODE.people ? px.people : px.subject;
      const s = smoothstep(0.5 - hf, 0.5 + hf, m);
      w = code === REGION_CODE.background ? 1 - s : s;
      break;
    }
    default: {
      const hf = 0.02 + 0.3 * sp;
      const n = smoothstep(split - hf, split + hf, px.depth);
      w = code === REGION_CODE.near ? n : 1 - n;
    }
  }
  return (row[base + 3] as number) > 0.5 ? 1 - w : w;
}

// ---- the ops ----

const hash21 = (x: number, y: number): number => {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  return fract((p3x + p3y) * p3z);
};

/** The op itself (no amount, region or pulse), kind code and params read from the row. */
export function opColor(row: Float32Array, base: number, c: Vec3, px: PixelCtx, index: number): Vec3 {
  const kind = row[base] as number;
  const L = luma(c);
  switch (kind) {
    case KIND_CODE.balance: {
      const exposure = f(row, base, 0, 0);
      const temp = f(row, base, 0, 1);
      const tint = f(row, base, 0, 2);
      const contrast = f(row, base, 0, 3);
      const pivot = f(row, base, 1, 0);
      const sat = f(row, base, 1, 1);
      const vib = f(row, base, 1, 2);
      let o: Vec3 = c;
      if (exposure !== 0) {
        const k = Math.pow(2, exposure);
        o = clampC(map3(o, (v) => toSrgb(Math.min(1, toLin(v) * k))));
      }
      o = [o[0] + temp * 0.1 + tint * 0.03, o[1] - tint * 0.06, o[2] - temp * 0.1 + tint * 0.03];
      o = map3(o, (v) => (v - pivot) * contrast + pivot);
      o = clampC(o);
      const l = luma(o);
      o = map3(o, (v) => mix(l, v, sat));
      const s = Math.max(o[0], o[1], o[2]) - Math.min(o[0], o[1], o[2]);
      const l2 = luma(o);
      const k = 1 + vib * (1 - s);
      return clampC(map3(o, (v) => mix(l2, v, k)));
    }
    case KIND_CODE.wheels: {
      const o = map3(c, (v, i) => {
        const lift = f(row, base, 0, i);
        const gamma = f(row, base, 1, i);
        const gain = f(row, base, 2, i);
        let x = v * (1 + gain * 0.6);
        x = x + lift * 0.3 * (1 - x);
        x = clamp01(x);
        x = Math.pow(x, Math.pow(2, -gamma * 0.8));
        return x + f(row, base, 0, 3) * 0.15;
      });
      return clampC(o);
    }
    case KIND_CODE.curves: {
      const y = (k: number) => [f(row, base, k * 2, 0), f(row, base, k * 2, 1), f(row, base, k * 2, 2), f(row, base, k * 2, 3), f(row, base, k * 2 + 1, 0)];
      const master = y(0);
      return map3(c, (v, i) => curve5(master, curve5(y(i + 1), v)));
    }
    case KIND_CODE.hsl: {
      const hsv = rgbToHsv(c);
      let dh = 0;
      let ds = 0;
      let dl = 0;
      for (let k = 0; k < 6; k++) {
        const d = Math.abs((((hsv[0] - 60 * k) % 360) + 540) % 360 - 180);
        const w = Math.max(0, 1 - d / 60);
        dh += w * f(row, base, k, 0);
        ds += w * f(row, base, k, 1);
        dl += w * f(row, base, k, 2);
      }
      const g = smoothstep(0, 0.2, hsv[1]);
      return clampC(hsvToRgb(hsv[0] + dh * g, clamp01(hsv[1] * (1 + ds * g)), clamp01(hsv[2] * (1 + dl * 0.6 * g))));
    }
    case KIND_CODE.split: {
      const sh: Vec3 = [f(row, base, 0, 0), f(row, base, 0, 1), f(row, base, 0, 2)];
      const hi: Vec3 = [f(row, base, 1, 0), f(row, base, 1, 1), f(row, base, 1, 2)];
      const mid = 0.5 + 0.25 * f(row, base, 0, 3);
      const sw = 1 - smoothstep(mid - 0.4, mid + 0.4, L);
      const hw = 1 - sw;
      const ls = luma(sh);
      const lh = luma(hi);
      return clampC(map3(c, (v, i) => v + sw * ((sh[i] as number) - ls) + hw * ((hi[i] as number) - lh)));
    }
    case KIND_CODE.gradmap: {
      const source = f(row, base, 0, 1);
      const blend = f(row, base, 0, 2);
      const shift = f(row, base, 0, 3) + driftOf(row, base, px, index);
      let t = source < 0.5 ? L : source < 1.5 ? px.depth : rgbToHsv(c)[0] / 360;
      if (shift !== 0) t = 1 - Math.abs(fract((t + shift) * 0.5) * 2 - 1);
      else t = clamp01(t);
      const g = gradientAt(row, base, t);
      if (blend < 0.5) return g;
      if (blend < 1.5) {
        const d = L - luma(g);
        return clampC([g[0] + d, g[1] + d, g[2] + d]);
      }
      return mix3(c, g, 0.5);
    }
    case KIND_CODE.chanmix: {
      const m = (r: number, j: number) => f(row, base, r, j);
      return clampC([0, 1, 2].map((r) => m(r, 0) * c[0] + m(r, 1) * c[1] + m(r, 2) * c[2] + m(r, 3)) as Vec3);
    }
    case KIND_CODE.solarize: {
      const thr = f(row, base, 0, 0);
      const mx = f(row, base, 0, 1);
      return map3(c, (v) => mix(v, mix(v, 1 - v, smoothstep(thr - 0.02, thr + 0.02, v)), mx));
    }
    case KIND_CODE.posterize: {
      const n = Math.max(2, Math.round(f(row, base, 0, 0)));
      return map3(c, (v) => Math.min(Math.floor(v * n), n - 1) / (n - 1));
    }
    case KIND_CODE.invert:
      return map3(c, (v, i) => (f(row, base, 0, i) > 0.5 ? 1 - v : v));
    case KIND_CODE.huecycle: {
      const by = f(row, base, 0, 0);
      const cycles = f(row, base, 0, 1);
      const phase = f(row, base, 0, 2);
      const v = by < 0.5 ? L : by < 1.5 ? px.depth : Math.min(1, Math.hypot(px.x - 0.5, px.y - 0.5) * 1.41421356);
      const th = 2 * Math.PI * (cycles * v + phase + driftOf(row, base, px, index));
      const cs = Math.cos(th);
      const sn = Math.sin(th) / Math.sqrt(3);
      const mean = (c[0] + c[1] + c[2]) / 3;
      const cross: Vec3 = [c[2] - c[1], c[0] - c[2], c[1] - c[0]];
      return clampC(map3(c, (x, i) => x * cs + (cross[i] as number) * sn + mean * (1 - cs)));
    }
    case KIND_CODE.transfer: {
      const lab = rgbToLab(c);
      const w = bandWeights(lab[0] / 100);
      const stat = (off: number, k: number) => {
        let s = 0;
        for (let b = 0; b < 3; b++) s += (w[b] as number) * (row[base + P0 + off + b * 6 + k] as number);
        return s;
      };
      const out = [0, 1, 2].map((k) => {
        const ms = stat(0, k);
        const ss = Math.max(1, stat(0, k + 3));
        const mr = stat(20, k);
        const sr = stat(20, k + 3);
        const gain = Math.max(0.25, Math.min(4, sr / ss));
        return (lab[k] as number - ms) * gain + mr;
      }) as Vec3;
      out[0] = Math.max(0, Math.min(100, out[0]));
      return labToRgb(out);
    }
    case KIND_CODE.bleach: {
      const d = mix3(c, [L, L, L], 0.6);
      const ld = luma(d);
      return clampC(map3(d, (v) => (ld < 0.5 ? 2 * v * ld : 1 - 2 * (1 - v) * (1 - ld))));
    }
    case KIND_CODE.grain: {
      const size = Math.max(0.5, f(row, base, 0, 0));
      const colored = f(row, base, 0, 1);
      const cx = Math.floor((px.x * px.w) / size);
      const cy = Math.floor((px.y * px.h) / size);
      const fr = Math.floor(px.t * 24);
      const n0 = hash21(cx + fr * 17.31, cy + fr * 5.17) - 0.5;
      const amp = 0.3 * (1 - Math.abs(2 * L - 1) * 0.5);
      return clampC(
        map3(c, (v, i) => {
          const ni = i === 0 ? n0 : hash21(cx + i * 91.7 + fr * 17.31, cy + i * 13.3 + fr * 5.17) - 0.5;
          return v + mix(n0, ni, colored) * amp;
        }),
      );
    }
    case KIND_CODE.vignette: {
      const size = f(row, base, 0, 0);
      const soft = f(row, base, 0, 1);
      const round = f(row, base, 0, 2);
      const aspect = px.w / Math.max(1, px.h);
      const dx = (px.x - 0.5) * 2 * mix(1, aspect, round * 0.8);
      const dy = (px.y - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const dk = smoothstep(size * 1.2, size * 1.2 + 0.2 + soft, r);
      return map3(c, (v) => v * (1 - 0.9 * dk));
    }
    default:
      return c;
  }
}

/** One row applied to c (amount × region × pulse), c0 being the chain's input (regions read its luma). */
export function applyRow(row: Float32Array, base: number, c: Vec3, c0: Vec3, px: PixelCtx, index: number): Vec3 {
  const amt = (row[base + 1] as number) * regionWeight(row, base, luma(c0), px) * pulseOf(row, base, px, index);
  if (amt <= 0) return c;
  const kind = row[base] as number;
  const o = kind === KIND_CODE.gate ? c : opColor(row, base, c, px, index);
  return mix3(c, o, amt);
}

/** The whole chain on one pixel (sRGB 0..1 in and out). */
export function evalRows(data: Float32Array, count: number, c: Vec3, px: PixelCtx = defaultPixel()): Vec3 {
  let cur = clampC(c);
  for (let i = 0; i < count; i++) cur = applyRow(data, i * ROW_FLOATS, cur, c, px, i);
  return cur;
}
