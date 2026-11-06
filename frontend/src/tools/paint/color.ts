/** Colour maths for the Colour panel (sRGB, pure functions). */
import type { RGBA } from "@/paint/engine/types";

export interface Hsv {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hexToHsv = (hex: string): Hsv => rgbToHsv(...hexToRgb(hex));
export const hsvToHex = (c: Hsv): string => rgbToHex(...hsvToRgb(c));

/** The engine's colour type: straight RGBA, each channel 0..1 (sRGB values, not gamma-expanded). */
export function hexToRGBA(hex: string, a = 1): RGBA {
  const [r, g, b] = hexToRgb(hex);
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

export function rgbaToHex(c: { r: number; g: number; b: number }): string {
  return rgbToHex(c.r * 255, c.g * 255, c.b * 255);
}

export function isHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s.trim());
}

export type Harmony = "complementary" | "analogous" | "triadic" | "split" | "tetradic";

/** The other colours of a harmony around `c` (the base colour is not included). */
export function harmonyColors(c: Hsv, kind: Harmony): string[] {
  const offsets: Record<Harmony, number[]> = {
    complementary: [180],
    analogous: [-30, 30],
    triadic: [120, 240],
    split: [150, 210],
    tetradic: [90, 180, 270],
  };
  return offsets[kind].map((o) => hsvToHex({ ...c, h: (c.h + o + 360) % 360 }));
}

/** CSS gradient for the hue ring/bar. */
export function hueGradient(dir = "to right"): string {
  const stops = Array.from({ length: 7 }, (_, i) => `hsl(${i * 60} 100% 50%)`).join(", ");
  return `linear-gradient(${dir}, ${stops})`;
}

/** The value square's background for a hue (saturation across, value down). */
export function squareGradient(h: number): string {
  return `linear-gradient(to top, hsl(0 0% 0%), transparent), linear-gradient(to right, hsl(0 0% 100%), hsl(${Math.round(h)} 100% 50%))`;
}

export const DEFAULT_PALETTES: Array<{ name: string; colors: string[] }> = [
  { name: "Ink & paper", colors: ["#111111", "#3a3a3a", "#6b6b6b", "#a8a8a8", "#d9d6d1", "#f5f1ea", "#ffffff"] },
  { name: "Earth", colors: ["#3b2a1e", "#6e4b2f", "#a9743f", "#d2a560", "#8a8d52", "#4d6b43", "#2c4a3e"] },
  { name: "Sky & sea", colors: ["#0b1f3a", "#1a4a7a", "#2f7fb8", "#7cc0e0", "#c9ecf2", "#f2d8a0", "#e89a5b"] },
  { name: "Warm", colors: ["#4a1520", "#8f2a2a", "#d1493c", "#f08a4b", "#f6c04f", "#f9e29a", "#fff4d6"] },
];
