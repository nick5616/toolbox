/** Pure logic for Lab devices (SPEC §1.4.0): value curves, Rand and its back/forward history. */
import type { LabParam, LabParams, LabToolInfo } from "@/paint/lab/types";

export type NumberParam = Extract<LabParam, { type: "number" }>;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** A control position 0..1 for a value (the "exp" curve gives small values more room). */
export function toNorm(p: NumberParam, v: number): number {
  const n = p.max === p.min ? 0 : clamp((v - p.min) / (p.max - p.min), 0, 1);
  return p.curve === "exp" ? Math.sqrt(n) : n;
}

/** The value (snapped to `step`) at a control position. */
export function fromNorm(p: NumberParam, n: number): number {
  const x = clamp(n, 0, 1);
  const lin = p.curve === "exp" ? x * x : x;
  return snap(p, p.min + (p.max - p.min) * lin);
}

export function snap(p: NumberParam, v: number): number {
  const step = p.step ?? (p.max - p.min >= 20 ? 1 : (p.max - p.min) / 100);
  const s = Math.round((v - p.min) / step) * step + p.min;
  return clamp(Number(s.toFixed(6)), p.min, p.max);
}

/** The readout text: value with its unit. */
export function readout(p: NumberParam, v: number): string {
  const step = p.step ?? 1;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${v.toFixed(digits)}${p.unit ? ` ${p.unit}` : ""}`;
}

/** Deterministic RNG (mulberry32). Rand never touches Math.random. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const nextRandSeed = (s: number): number => (Math.imul(s, 1103515245) + 12345) & 0x7fffffff || 1;

/**
 * Rand: every param that isn't `rand === false` and isn't in `locked` gets a
 * new value from the seeded RNG; the others keep their current value.
 */
export function randomize(info: Pick<LabToolInfo, "params">, current: LabParams, locked: ReadonlySet<string>, seed: number): LabParams {
  const r = rng(seed);
  const out: LabParams = { ...current };
  for (const p of info.params) {
    const roll = r(); // consume one value per param so a lock doesn't shift the others
    if (p.rand === false || locked.has(p.id)) continue;
    if (p.type === "number") out[p.id] = fromNorm(p, roll);
    else if (p.type === "toggle") out[p.id] = roll < 0.5;
    else out[p.id] = p.choices[Math.min(p.choices.length - 1, Math.floor(roll * p.choices.length))]?.value ?? p.default;
  }
  return out;
}

export interface RandHistory {
  states: LabParams[];
  index: number;
}

export const newHistory = (start: LabParams): RandHistory => ({ states: [start], index: 0 });

/** Pushes a Rand result after the current state (dropping any forward states). */
export function pushRand(h: RandHistory, next: LabParams): RandHistory {
  const states = [...h.states.slice(0, h.index + 1), next].slice(-50);
  return { states, index: states.length - 1 };
}

export const canBack = (h: RandHistory): boolean => h.index > 0;
export const canForward = (h: RandHistory): boolean => h.index < h.states.length - 1;
export const back = (h: RandHistory): RandHistory => (canBack(h) ? { ...h, index: h.index - 1 } : h);
export const forward = (h: RandHistory): RandHistory => (canForward(h) ? { ...h, index: h.index + 1 } : h);
export const current = (h: RandHistory): LabParams => h.states[h.index] ?? {};

/** A saved device variant (stored as a brush-set entry in the "lab-devices" set). */
export interface DeviceVariant {
  id: string;
  name: string;
  set: "lab-devices";
  toolId: string;
  params: LabParams;
  seed: number;
}
