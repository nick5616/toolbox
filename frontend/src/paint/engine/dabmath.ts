// Per-pixel dab alpha on the CPU: the reference for dab.frag, also used by the
// smudge brush (which works on pixels, not on the GPU).

import { D, type DabStyle, type MaskTex, type TipStyle } from "./gl";
import { clamp } from "./pixels";

/** Mask textures keep a CPU copy so CPU consumers (smudge, tests) can sample them. */
export interface MaskData extends MaskTex {
  data: Float32Array;
}

/** A colour tip: `data` is its alpha, `rgb` its straight colour (3 floats per texel). */
export interface ColorMaskData extends MaskData {
  rgb: Float32Array;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Analytic tip coverage at normalised coordinates (n = -1..1 across the dab); ix, iy are one pixel in those units. */
export function analyticCoverage(shape: "round" | "square", nx: number, ny: number, hard: number, ix: number, iy: number, aa: boolean): number {
  let d: number;
  let g: number;
  if (shape === "square") {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    d = Math.max(ax, ay);
    g = ax > ay ? ix : iy;
  } else {
    d = Math.hypot(nx, ny);
    g = Math.hypot(nx * ix, ny * iy) / Math.max(d, 0.0001);
  }
  if (!aa) return d <= 1 ? 1 : 0;
  const w = Math.max(1 - hard, g);
  return smooth(clamp((1 - d) / w, 0, 1));
}

export function sampleMask(m: MaskData, u: number, v: number, wrap: boolean, linear: boolean): number {
  const w = m.w;
  const h = m.h;
  if (!linear) {
    let x = Math.floor(u * w);
    let y = Math.floor(v * h);
    if (wrap) {
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
    } else {
      x = clamp(x, 0, w - 1);
      y = clamp(y, 0, h - 1);
    }
    return m.data[y * w + x] as number;
  }
  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xx: number, yy: number) => {
    if (wrap) {
      xx = ((xx % w) + w) % w;
      yy = ((yy % h) + h) % h;
    } else {
      xx = clamp(xx, 0, w - 1);
      yy = clamp(yy, 0, h - 1);
    }
    return m.data[yy * w + xx] as number;
  };
  const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

export function tipCoverage(tip: TipStyle, nx: number, ny: number, ix: number, iy: number, aa: boolean): number {
  if (tip.shape === "image" || tip.shape === "color") {
    if (!tip.tex || nx < -1 || nx > 1 || ny < -1 || ny > 1) return 0;
    const c = sampleMask(tip.tex as MaskData, nx * 0.5 + 0.5, ny * 0.5 + 0.5, false, aa);
    return tip.invert ? 1 - c : c;
  }
  const c = analyticCoverage(tip.shape, nx, ny, tip.hardness, ix, iy, aa);
  return tip.invert ? 1 - c : c;
}

/** Straight colour of a colour tip at u, v (alpha-weighted bilinear, so transparent texels never bleed in). */
export function sampleTipColor(m: ColorMaskData, u: number, v: number, linear: boolean, out: number[]): void {
  const w = m.w;
  const h = m.h;
  const fx = linear ? u * w - 0.5 : Math.floor(u * w);
  const fy = linear ? v * h - 0.5 : Math.floor(v * h);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = linear ? fx - x0 : 0;
  const ty = linear ? fy - y0 : 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const xx = clamp(x0 + (k & 1), 0, w - 1);
    const yy = clamp(y0 + (k >> 1), 0, h - 1);
    const wt = ((k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty)) * (m.data[yy * w + xx] as number);
    const i = (yy * w + xx) * 3;
    r += wt * (m.rgb[i] as number);
    g += wt * (m.rgb[i + 1] as number);
    b += wt * (m.rgb[i + 2] as number);
    wsum += wt;
  }
  if (wsum <= 0) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = r / wsum;
  out[1] = g / wsum;
  out[2] = b / wsum;
}

/**
 * The colour a dab paints at canvas px centre (wx, wy) when its tip is a colour tip: the tip's
 * own colour, tinted toward the dab's colour by the tip's `hardness`. False for other tips.
 */
export function colorTipAt(style: DabStyle, g: DabGeo, wx: number, wy: number, dab: [number, number, number], out: number[]): boolean {
  const tip = style.tip;
  if (tip.shape !== "color" || !tip.tex) return false;
  const fx = wx - g.x;
  const fy = wy - g.y;
  const lx = (fx * g.cs + fy * g.sn) / g.hw;
  const ly = (-fx * g.sn + fy * g.cs) / g.hh;
  sampleTipColor(tip.tex as ColorMaskData, lx * 0.5 + 0.5, ly * 0.5 + 0.5, style.antialias, out);
  const t = tip.hardness;
  out[0] = (out[0] as number) * (1 - t) + dab[0] * t;
  out[1] = (out[1] as number) * (1 - t) + dab[1] * t;
  out[2] = (out[2] as number) * (1 - t) + dab[2] * t;
  return true;
}

/** One dab's constants, unpacked once. */
export interface DabGeo {
  x: number;
  y: number;
  size: number;
  hw: number;
  hh: number;
  cs: number;
  sn: number;
  alpha: number;
  gx: number;
  gy: number;
  dcs: number;
  dsn: number;
  dScale: number;
  /** One pixel in the tip's normalised coordinates, along x and y. */
  ix: number;
  iy: number;
  /** Half the bounding box (px) to loop over. */
  reach: number;
}

export function newGeo(): DabGeo {
  return { x: 0, y: 0, size: 0, hw: 0, hh: 0, cs: 1, sn: 0, alpha: 0, gx: 0, gy: 0, dcs: 1, dsn: 0, dScale: 1, ix: 1, iy: 1, reach: 0 };
}

/** Unpack dab `o` of `f`; false when it paints nothing. */
export function loadDab(g: DabGeo, f: Float32Array, o: number): boolean {
  g.size = f[o + D.SIZE] as number;
  g.alpha = f[o + D.ALPHA] as number;
  if (g.alpha <= 0 || g.size <= 0) return false;
  g.x = f[o + D.X] as number;
  g.y = f[o + D.Y] as number;
  const rnd = Math.max(f[o + D.ROUND] as number, 0.0001);
  g.hw = g.size * 0.5;
  g.hh = Math.max(g.hw * rnd, 0.5);
  const ang = f[o + D.ANGLE] as number;
  g.cs = Math.cos(ang);
  g.sn = Math.sin(ang);
  g.gx = f[o + D.GX] as number;
  g.gy = f[o + D.GY] as number;
  const da = f[o + D.DANGLE] as number;
  g.dcs = Math.cos(da);
  g.dsn = Math.sin(da);
  g.dScale = f[o + D.DSCALE] as number;
  g.ix = 1 / g.hw;
  g.iy = 1 / g.hh;
  g.reach = Math.hypot(g.hw, g.hh) + 1;
  return true;
}

/** Final alpha (coverage × flow × grain, intense curve applied) at canvas px centre (wx, wy). */
export function dabAlpha(style: DabStyle, g: DabGeo, wx: number, wy: number): number {
  const fx = wx - g.x;
  const fy = wy - g.y;
  const lx = fx * g.cs + fy * g.sn;
  const ly = -fx * g.sn + fy * g.cs;
  const aa = style.antialias;
  let cov = tipCoverage(style.tip, lx / g.hw, ly / g.hh, g.ix, g.iy, aa);
  if (cov <= 0) return 0;
  if (style.dual) {
    const ex = lx * g.dcs + ly * g.dsn;
    const ey = -lx * g.dsn + ly * g.dcs;
    const dr = Math.max(style.dual.roundness, 0.0001);
    cov *= tipCoverage(style.dual, ex / (g.hw * g.dScale), ey / (g.hw * g.dScale * dr), g.ix / g.dScale, g.ix / (g.dScale * dr), aa);
    if (cov <= 0) return 0;
  }
  let a = cov * g.alpha;
  const grain = style.grain;
  if (grain && grain.tex) {
    const gt = grain.tex as MaskData;
    const gpx = grain.texturised ? wx : lx + g.gx;
    const gpy = grain.texturised ? wy : ly + g.gy;
    const gv = sampleMask(gt, gpx / (gt.w * grain.scale), gpy / (gt.h * grain.scale), true, aa);
    const g2 = clamp((gv - 0.5) * grain.contrast + 0.5, 0, 1);
    a *= 1 - grain.depth * (1 - g2);
  }
  a = clamp(a, 0, 1);
  if (style.rendering === 2) a = 1 - (1 - a) * (1 - a);
  return a;
}
