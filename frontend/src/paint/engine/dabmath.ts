// Per-pixel dab alpha on the CPU: the reference for dab.frag, also used by the
// smudge brush (which works on pixels, not on the GPU).

import { D, type DabStyle, type MaskTex, type TipStyle } from "./gl";
import { clamp } from "./pixels";

/** Mask textures keep a CPU copy so CPU consumers (smudge, tests) can sample them. */
export interface MaskData extends MaskTex {
  data: Float32Array;
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
  if (tip.shape === "image") {
    if (!tip.tex || nx < -1 || nx > 1 || ny < -1 || ny > 1) return 0;
    const c = sampleMask(tip.tex as MaskData, nx * 0.5 + 0.5, ny * 0.5 + 0.5, false, aa);
    return tip.invert ? 1 - c : c;
  }
  const c = analyticCoverage(tip.shape, nx, ny, tip.hardness, ix, iy, aa);
  return tip.invert ? 1 - c : c;
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
