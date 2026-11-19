/** Small colour helpers shared by the op catalog, the packer and the reference maths (pure). */

export type Vec3 = [number, number, number];

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (s: unknown): s is string => typeof s === "string" && HEX.test(s);

/** "#rrggbb" → sRGB-encoded 0..1 (what the colour ops work in). */
export function hexToSrgb(hex: string): Vec3 {
  const n = isHex(hex) ? parseInt(hex.slice(1), 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function srgbToHex(c: readonly number[]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return `#${h(c[0] ?? 0)}${h(c[1] ?? 0)}${h(c[2] ?? 0)}`;
}

export const MAX_STOPS = 8;

export interface Stop {
  hex: string;
  pos: number;
}

/** Parses "#rrggbb@0.25,…"; null unless there are 2..8 valid stops. Sorted by position, positions clamped to 0..1. */
export function parseStops(s: unknown): Stop[] | null {
  if (typeof s !== "string") return null;
  const out: Stop[] = [];
  for (const part of s.split(",")) {
    const [hex, pos] = part.trim().split("@");
    const p = Number(pos);
    if (!isHex(hex) || pos === undefined || !Number.isFinite(p)) return null;
    out.push({ hex: hex.toLowerCase(), pos: Math.max(0, Math.min(1, p)) });
  }
  if (out.length < 2 || out.length > MAX_STOPS) return null;
  return out.sort((a, b) => a.pos - b.pos);
}

export function formatStops(stops: readonly Stop[]): string {
  return stops.map((s) => `${s.hex.toLowerCase()}@${s.pos}`).join(",");
}

/** A gradient from evenly spaced colours: evenStops("#000000", "#ffffff"). */
export function evenStops(...hexes: string[]): string {
  return formatStops(hexes.map((hex, i) => ({ hex, pos: hexes.length === 1 ? 0 : i / (hexes.length - 1) })));
}
