export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 0..100
}

export interface Oklch {
  l: number; // 0..1
  c: number;
  h: number; // 0..360
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, d = 0) => {
  const p = 10 ** d;
  return Math.round(n * p) / p;
};

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl, a = 1): Rgb {
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r! + m) * 255, g: (g! + m) * 255, b: (b! + m) * 255, a };
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: c < 1e-4 ? 0 : c, h: c < 1e-4 ? 0 : h };
}

/** Out-of-gamut colours are clipped to sRGB. */
export function oklchToRgb({ l: L, c, h }: Oklch, a = 1): Rgb {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return {
    r: clamp(fromLinear(clamp(lr, 0, 1)), 0, 255),
    g: clamp(fromLinear(clamp(lg, 0, 1)), 0, 255),
    b: clamp(fromLinear(clamp(lb, 0, 1)), 0, 255),
    a,
  };
}

const NUM = String.raw`(-?\d*\.?\d+(?:e[+-]?\d+)?)`;
const SEP = String.raw`\s*[,\s]\s*`;

function num(s: string | undefined): number {
  return Number(s);
}

function alphaOf(s: string | undefined): number {
  if (s === undefined) return 1;
  return s.endsWith("%") ? num(s.slice(0, -1)) / 100 : num(s);
}

/** Parses #hex (3/4/6/8), rgb()/rgba(), hsl()/hsla() and oklch(). */
export function parseColor(text: string): Rgb | null {
  const t = text.trim().toLowerCase();
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) / 255 : 1 };
  }
  const alpha = String.raw`(?:\s*[,/]\s*(${NUM}%?))?`;
  m = new RegExp(`^rgba?\\(\\s*${NUM}(%?)${SEP}${NUM}(%?)${SEP}${NUM}(%?)${alpha}\\s*\\)$`).exec(t);
  if (m) {
    const ch = (v: string | undefined, pct: string | undefined) => clamp(pct ? (num(v) / 100) * 255 : num(v), 0, 255);
    return { r: ch(m[1], m[2]), g: ch(m[3], m[4]), b: ch(m[5], m[6]), a: clamp(alphaOf(m[8] === undefined ? undefined : m[7]), 0, 1) };
  }
  m = new RegExp(`^hsla?\\(\\s*${NUM}(?:deg)?${SEP}${NUM}%${SEP}${NUM}%${alpha}\\s*\\)$`).exec(t);
  if (m) return hslToRgb({ h: num(m[1]), s: num(m[2]), l: num(m[3]) }, clamp(alphaOf(m[4]), 0, 1));
  m = new RegExp(`^oklch\\(\\s*${NUM}(%?)${SEP}${NUM}${SEP}${NUM}(?:deg)?${alpha}\\s*\\)$`).exec(t);
  if (m) {
    const l = m[2] ? num(m[1]) / 100 : num(m[1]);
    return oklchToRgb({ l, c: num(m[3]), h: num(m[4]) }, clamp(alphaOf(m[5]), 0, 1));
  }
  return null;
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");

export function formatHex(c: Rgb): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ""}`;
}

export function formatRgb(c: Rgb): string {
  const base = `${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}`;
  return c.a < 1 ? `rgb(${base} / ${round(c.a, 3)})` : `rgb(${base})`;
}

export function formatHsl(c: Rgb): string {
  const h = rgbToHsl(c);
  const base = `${round(h.h, 1)} ${round(h.s, 1)}% ${round(h.l, 1)}%`;
  return c.a < 1 ? `hsl(${base} / ${round(c.a, 3)})` : `hsl(${base})`;
}

export function formatOklch(c: Rgb): string {
  const o = rgbToOklch(c);
  const base = `${round(o.l * 100, 2)}% ${round(o.c, 4)} ${round(o.h, 2)}`;
  return c.a < 1 ? `oklch(${base} / ${round(c.a, 3)})` : `oklch(${base})`;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio (1..21); alpha is ignored. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface WcagBadges {
  aaNormal: boolean;
  aaLarge: boolean;
  aaaNormal: boolean;
  aaaLarge: boolean;
}

export function wcag(ratio: number): WcagBadges {
  return { aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 };
}
