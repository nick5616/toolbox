// Seeded randomness for strokes and Lab tools. Never Math.random: a stroke
// replayed with the same points, brush and seed must give the same pixels.

/** mulberry32: small, fast, good enough for jitter. Returns 0 <= x < 1. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A named stream derived from a seed (Lab tools' `ctx.rng(key)`). */
export function keyedRng(seed: number, key: string): () => number {
  return createRng((seed ^ hashString(key)) >>> 0);
}

/** Mix two 32-bit values (a copy index into a stroke seed, say). */
export function mixSeed(seed: number, n: number): number {
  return (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(n + 1, 0xc2b2ae35)) >>> 0;
}
