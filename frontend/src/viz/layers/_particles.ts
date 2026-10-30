/**
 * Shared helpers for particle, accent and motif layers (Phase 7, L3): integer
 * hashing for per-slot randomness, palette picking, closed-form motion and a
 * sprite batch. Everything here is a pure function of its inputs.
 */
import type { Analysis } from "../analysis";
import type { Program } from "../gl/core";
import { QuadBatch } from "../gl/quads";
import { mixLinear, type ResolvedPalette, type RGB } from "../palette";
import { SHADE_SPRITES, type SpriteKind } from "./_sprites";

/** Deterministic hash of up to three integers to [0, 1). */
export function ihash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A per-slot random number: stream `k` of slot `i` in cycle `cyc` for a seed. */
export function rnd(seed: number, i: number, k: number, cyc = 0): number {
  return ihash((seed | 0) ^ Math.imul(k + 1, 0x27d4eb2f), i, cyc);
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const COLOR_OPTIONS = ["duo", "cycle", "c0", "c1", "c2", "c3", "accent", "glow"] as const;

/** A palette colour for a mode; "duo" blends accent to glow by frac(t), "cycle" blends along the four colours at position t. */
export function pickColor(pal: ResolvedPalette, mode: string, t = 0): RGB {
  switch (mode) {
    case "c0":
      return pal.colors[0];
    case "c1":
      return pal.colors[1];
    case "c2":
      return pal.colors[2];
    case "c3":
      return pal.colors[3];
    case "accent":
      return pal.accent;
    case "glow":
      return pal.glow;
    case "duo":
      return mixLinear(pal.accent, pal.glow, ((t % 1) + 1) % 1);
    default: {
      const k = ((t % 4) + 4) % 4;
      const i = Math.floor(k);
      return mixLinear(pal.colors[i as 0 | 1 | 2 | 3], pal.colors[((i + 1) % 4) as 0 | 1 | 2 | 3], k - i);
    }
  }
}

/** The first channel of a list that exists in the analysis, so stem-less songs still react. */
export function channelId(a: Analysis, ...ids: string[]): string {
  for (const id of ids) if (a.has(id)) return id;
  return ids[ids.length - 1] ?? "mix.level";
}

/** Distance travelled by a velocity v0 damped at rate k (1/s) after `age` seconds. */
export function dampedDistance(v0: number, k: number, age: number): number {
  return k < 1e-4 ? v0 * age : (v0 * (1 - Math.exp(-k * age))) / k;
}

export const PARTICLE_CAP = 600;

/** Sprite quads with the generated atlas; tracks the largest sprite so the halo padding fits. */
export class SpriteBatch {
  private readonly batch: QuadBatch;
  private maxR = 1;
  private opacity = 1;

  constructor(gl: WebGL2RenderingContext, capacity = 640) {
    this.batch = new QuadBatch(gl, SHADE_SPRITES, capacity);
  }

  begin(opacity = 1): void {
    this.batch.begin();
    this.maxR = 1;
    this.opacity = opacity;
  }

  get count(): number {
    return this.batch.count;
  }

  /**
   * Adds a sprite: centre (px, y down), half extents, linear colour (HDR ok), alpha,
   * rotation, and the kind's aux/hot floats.
   */
  add(kind: SpriteKind, cx: number, cy: number, hw: number, hh: number, rgb: RGB, a: number, rot = 0, aux = 0, hot = 0, bright = 1, halo = true): void {
    a *= this.opacity;
    if (a <= 0.002 || hw <= 0 || hh <= 0) return;
    const r = Math.min(hw, hh);
    if (halo && r > this.maxR) this.maxR = r;
    this.batch.push(cx, cy, hw, hh, rgb[0] * bright, rgb[1] * bright, rgb[2] * bright, a, rot, kind, aux, hot);
  }

  /** Draws into the bound target. glowK is the halo radius as a fraction of each sprite's size. */
  draw(w: number, h: number, glowK: number, extra?: (p: Program) => void): void {
    this.batch.draw(w, h, Math.ceil(this.maxR * (2 + 3 * glowK)), (p) => {
      p.f1("u_glow", glowK);
      extra?.(p);
    });
  }

  dispose(): void {
    this.batch.dispose();
  }
}
