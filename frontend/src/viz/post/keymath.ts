/**
 * Pure-TS reference for the chroma key and luma key shaders (Phase 21 SPEC
 * §B4), mirrored line by line by `chromakey.ts` and `lumakey.ts`. Colours are
 * linear light; the keys work on the display encoding (gamma 2.2) so the
 * distances match what the eye sees. Output is premultiplied.
 */

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

const GAMMA = 2.2;
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Linear → display encoding. */
export const encode = (v: number): number => Math.pow(Math.max(v, 0), 1 / GAMMA);

/** Weight of the luma difference next to the CbCr distance. */
export const LUMA_WEIGHT = 0.25;

/** BT.709 Y, Cb, Cr of a linear colour (computed on its display encoding). */
export function ycc(rgb: Vec3): Vec3 {
  const r = encode(rgb[0]);
  const g = encode(rgb[1]);
  const b = encode(rgb[2]);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [y, (b - y) / 1.8556, (r - y) / 1.5748];
}

/** Distance of a (straight, linear) colour from the key colour: CbCr plane plus 0.25 of the luma difference. */
export function chromaDistance(rgb: Vec3, key: Vec3): number {
  const a = ycc(rgb);
  const k = ycc(key);
  return Math.hypot(a[1] - k[1], a[2] - k[2], LUMA_WEIGHT * (a[0] - k[0]));
}

/** Alpha from the distance: 0 inside `similarity`, 1 past similarity + smoothness. */
export function chromaAlpha(d: number, similarity: number, smoothness: number): number {
  return smoothstep(similarity, similarity + Math.max(smoothness, 1e-4), d);
}

/** Index of the key's dominant channel. */
export function dominantChannel(key: Vec3): 0 | 1 | 2 {
  return key[1] >= key[0] && key[1] >= key[2] ? 1 : key[2] > key[0] && key[2] > key[1] ? 2 : 0;
}

/** Spill suppression: the key's dominant channel is pulled toward the max of the other two, by `spill`. */
export function despill(rgb: Vec3, key: Vec3, spill: number): Vec3 {
  const d = dominantChannel(key);
  const o1 = rgb[(d + 1) % 3] as number;
  const o2 = rgb[(d + 2) % 3] as number;
  const out: Vec3 = [rgb[0], rgb[1], rgb[2]];
  out[d] = mix(rgb[d] as number, Math.min(rgb[d] as number, Math.max(o1, o2)), clamp01(spill));
  return out;
}

/** One 3 × 3 erode (choke < 0) or dilate (choke > 0) pass on alpha, mixed by |choke|. `ring` is the 8 neighbours. */
export function chokeAlpha(centre: number, ring: readonly number[], choke: number): number {
  if (choke === 0) return centre;
  const edge = choke < 0 ? Math.min(centre, ...ring) : Math.max(centre, ...ring);
  return mix(centre, edge, Math.min(1, Math.abs(choke)));
}

export interface ChromaParams {
  key: Vec3;
  similarity: number;
  smoothness: number;
  spill: number;
  choke: number;
  view: "composite" | "matte" | "source";
  amount: number;
}

export const CHROMA_DEFAULTS = { similarity: 0.18, smoothness: 0.08, spill: 0.5, choke: 0, view: "composite", amount: 1 } as const;

/** The key's alpha for a straight linear colour (before choke). */
export function chromaKeyAlpha(rgb: Vec3, p: Pick<ChromaParams, "key" | "similarity" | "smoothness">): number {
  return chromaAlpha(chromaDistance(rgb, p.key), p.similarity, p.smoothness);
}

/**
 * One pixel: premultiplied linear in, premultiplied out. `ring` holds the key
 * alphas (chromaKeyAlpha) of the 8 neighbours, needed only when choke ≠ 0.
 */
export function chromaKeyPixel(px: Vec4, p: ChromaParams, ring: readonly number[] = []): Vec4 {
  if (p.amount <= 0 || p.view === "source") return [...px];
  const a = px[3];
  const s: Vec3 = a > 1e-5 ? [px[0] / a, px[1] / a, px[2] / a] : [0, 0, 0];
  const centre = chromaKeyAlpha(s, p);
  const k = chokeAlpha(centre, ring, p.choke);
  const outA = a * k;
  const clean = despill(s, p.key, p.spill);
  const keyed: Vec4 = p.view === "matte" ? [outA, outA, outA, a] : [clean[0] * outA, clean[1] * outA, clean[2] * outA, outA];
  const m = clamp01(p.amount);
  return [mix(px[0], keyed[0], m), mix(px[1], keyed[1], m), mix(px[2], keyed[2], m), mix(px[3], keyed[3], m)];
}

// ---- luma key ----

export interface LumaParams {
  threshold: number;
  softness: number;
  invert: boolean;
  amount: number;
}

export const LUMA_DEFAULTS = { threshold: 0.1, softness: 0.1, invert: false, amount: 1 } as const;

/** Display luma of a straight linear colour. */
export function displayLuma(rgb: Vec3): number {
  return 0.2126 * encode(rgb[0]) + 0.7152 * encode(rgb[1]) + 0.0722 * encode(rgb[2]);
}

/** The luma key's alpha: dark parts go transparent (bright ones with `invert`). */
export function lumaKeyAlpha(rgb: Vec3, p: Pick<LumaParams, "threshold" | "softness" | "invert">): number {
  const a = smoothstep(p.threshold, p.threshold + Math.max(p.softness, 1e-4), displayLuma(rgb));
  return p.invert ? 1 - a : a;
}

export function lumaKeyPixel(px: Vec4, p: LumaParams): Vec4 {
  if (p.amount <= 0) return [...px];
  const a = px[3];
  const s: Vec3 = a > 1e-5 ? [px[0] / a, px[1] / a, px[2] / a] : [0, 0, 0];
  const k = lumaKeyAlpha(s, p);
  const m = clamp01(p.amount);
  return [mix(px[0], px[0] * k, m), mix(px[1], px[1] * k, m), mix(px[2], px[2] * k, m), mix(a, a * k, m)];
}
