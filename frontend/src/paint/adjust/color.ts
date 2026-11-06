// Colour adjustments on straight RGBA images (HSB, colour balance, curves,
// gradient map). Each returns a new image and leaves its input alone, so a
// live preview can re-run from the same snapshot.

import { bakeCurve } from "../brushes/curve";
import type { Curve } from "../brushes/schema";
import { makeImageData } from "../engine/pixels";

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function clone(img: Img): { data: Uint8ClampedArray; out: ImageData } {
  const data = new Uint8ClampedArray(img.data);
  return { data, out: makeImageData(img.width, img.height, data) };
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

export interface HSBParams {
  /** Degrees, -180..180. */
  hue: number;
  /** -1..1 */
  saturation: number;
  /** -1..1 */
  brightness: number;
}

export function hsb(img: Img, p: HSBParams): ImageData {
  const { data, out } = clone(img);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl((data[i] as number) / 255, (data[i + 1] as number) / 255, (data[i + 2] as number) / 255);
    const nh = (((h + p.hue / 360) % 1) + 1) % 1;
    const ns = Math.max(0, Math.min(1, p.saturation >= 0 ? s + (1 - s) * p.saturation * s : s * (1 + p.saturation)));
    const nl = Math.max(0, Math.min(1, p.brightness >= 0 ? l + (1 - l) * p.brightness : l * (1 + p.brightness)));
    const [r, g, b] = hslToRgb(nh, ns, nl);
    data[i] = Math.round(r * 255);
    data[i + 1] = Math.round(g * 255);
    data[i + 2] = Math.round(b * 255);
  }
  return out;
}

export interface BalanceParams {
  /** Each -1..1: [cyan↔red, magenta↔green, yellow↔blue]. */
  shadows: [number, number, number];
  midtones: [number, number, number];
  highlights: [number, number, number];
  preserveLuminosity: boolean;
}

export function colorBalance(img: Img, p: BalanceParams): ImageData {
  const { data, out } = clone(img);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = (data[i] as number) / 255;
    let g = (data[i + 1] as number) / 255;
    let b = (data[i + 2] as number) / 255;
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    const ws = Math.max(0, 1 - l * 3.2) ** 1.5;
    const wh = Math.max(0, l * 3.2 - 2.2) ** 1.5;
    const wm = Math.max(0, 1 - ws - wh);
    const dr = (p.shadows[0] * ws + p.midtones[0] * wm + p.highlights[0] * wh) * 0.4;
    const dg = (p.shadows[1] * ws + p.midtones[1] * wm + p.highlights[1] * wh) * 0.4;
    const db = (p.shadows[2] * ws + p.midtones[2] * wm + p.highlights[2] * wh) * 0.4;
    r = Math.max(0, Math.min(1, r + dr));
    g = Math.max(0, Math.min(1, g + dg));
    b = Math.max(0, Math.min(1, b + db));
    if (p.preserveLuminosity) {
      const nl = 0.3 * r + 0.59 * g + 0.11 * b;
      if (nl > 0) {
        const k = l / nl;
        r = Math.min(1, r * k);
        g = Math.min(1, g * k);
        b = Math.min(1, b * k);
      }
    }
    data[i] = Math.round(r * 255);
    data[i + 1] = Math.round(g * 255);
    data[i + 2] = Math.round(b * 255);
  }
  return out;
}

export interface CurvesParams {
  master?: Curve;
  r?: Curve;
  g?: Curve;
  b?: Curve;
}

/** 256-entry lookup: the channel curve, then the master curve. */
export function curveLUT(channel: Curve | undefined, master: Curve | undefined): Uint8ClampedArray {
  const c = bakeCurve(channel);
  const m = bakeCurve(master);
  const out = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) out[i] = Math.round(m.at(c.at(i / 255)) * 255);
  return out;
}

export function curves(img: Img, p: CurvesParams): ImageData {
  const { data, out } = clone(img);
  const lr = curveLUT(p.r, p.master);
  const lg = curveLUT(p.g, p.master);
  const lb = curveLUT(p.b, p.master);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = lr[data[i] as number] as number;
    data[i + 1] = lg[data[i + 1] as number] as number;
    data[i + 2] = lb[data[i + 2] as number] as number;
  }
  return out;
}

export interface GradientStop {
  /** 0..1 */
  pos: number;
  /** Straight 0..1 colour. */
  r: number;
  g: number;
  b: number;
}

export function gradientLUT(stops: GradientStop[]): Uint8ClampedArray {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = s[0] as GradientStop;
    let b = s[s.length - 1] as GradientStop;
    for (let k = 0; k < s.length - 1; k++) {
      if (t >= (s[k] as GradientStop).pos && t <= (s[k + 1] as GradientStop).pos) {
        a = s[k] as GradientStop;
        b = s[k + 1] as GradientStop;
        break;
      }
    }
    const span = b.pos - a.pos;
    const f = span <= 0 ? 0 : Math.max(0, Math.min(1, (t - a.pos) / span));
    const w = t <= a.pos && a === b ? 0 : f;
    out[i * 3] = Math.round((a.r + (b.r - a.r) * w) * 255);
    out[i * 3 + 1] = Math.round((a.g + (b.g - a.g) * w) * 255);
    out[i * 3 + 2] = Math.round((a.b + (b.b - a.b) * w) * 255);
  }
  return out;
}

export function gradientMap(img: Img, stops: GradientStop[]): ImageData {
  const { data, out } = clone(img);
  if (stops.length === 0) return out;
  const lut = gradientLUT(stops);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const l = Math.round(0.3 * (data[i] as number) + 0.59 * (data[i + 1] as number) + 0.11 * (data[i + 2] as number));
    data[i] = lut[l * 3] as number;
    data[i + 1] = lut[l * 3 + 1] as number;
    data[i + 2] = lut[l * 3 + 2] as number;
  }
  return out;
}
