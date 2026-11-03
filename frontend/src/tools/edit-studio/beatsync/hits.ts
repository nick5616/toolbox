/**
 * "Hits on": the simple way to wire an effect to the music. An effect's main
 * parameter (its amount) either stays off, stays on, or pulses on every Nth
 * marker of a lane (beat, downbeat, kick, snare…). This reads and writes the
 * same EditParam marker mods the advanced editor shows.
 */
import type { ParamSpec } from "@/viz/layers/registry";
import type { EditMod, EditParam, EditPost, MarkerLane } from "@/viz/edit/types";

export type HitLane = MarkerLane;
export type HitMode = "off" | "on" | HitLane;

export const HIT_LANES: ReadonlyArray<{ value: HitLane; label: string }> = [
  { value: "beat", label: "Every beat" },
  { value: "downbeat", label: "Downbeats" },
  { value: "kick", label: "Kicks" },
  { value: "snare", label: "Snares" },
  { value: "hats", label: "Hi-hats" },
  { value: "bass", label: "Bass hits" },
  { value: "vocals", label: "Vocal hits" },
  { value: "drop", label: "Drops" },
  { value: "section", label: "Section changes" },
  { value: "word", label: "Words" },
];

export const HIT_DECAYS = [
  { value: 90, label: "Snappy" },
  { value: 180, label: "Punchy" },
  { value: 400, label: "Long" },
] as const;

export interface HitState {
  mode: HitMode;
  /** 0..1 of the parameter's range. */
  strength: number;
  every: number;
  decayMs: number;
}

/** The parameter "Hits on" drives: "amount" when the effect has one, else its first number. */
export function mainParam(specs: Record<string, ParamSpec>): { name: string; spec: Extract<ParamSpec, { kind: "number" }> } | null {
  const amount = specs.amount;
  if (amount && amount.kind === "number") return { name: "amount", spec: amount };
  for (const [name, spec] of Object.entries(specs)) if (spec.kind === "number") return { name, spec };
  return null;
}

const DEFAULT_STRENGTH = 0.8;

/** Reads the hit state of a post's main parameter. */
export function readHit(post: EditPost, specs: Record<string, ParamSpec>): HitState | null {
  const m = mainParam(specs);
  if (!m) return null;
  const range = m.spec.max - m.spec.min || 1;
  const v = post.params[m.name];
  if (v === undefined || typeof v === "string" || typeof v === "boolean") {
    const base = m.spec.default;
    return { mode: base > m.spec.min ? "on" : "off", strength: base > m.spec.min ? (base - m.spec.min) / range : DEFAULT_STRENGTH, every: 1, decayMs: 180 };
  }
  if (typeof v === "number") return { mode: v > m.spec.min ? "on" : "off", strength: v > m.spec.min ? (v - m.spec.min) / range : DEFAULT_STRENGTH, every: 1, decayMs: 180 };
  const mod = v.mods?.find((x) => x.signal.startsWith("marker."));
  if (mod) return { mode: mod.signal.slice("marker.".length) as HitLane, strength: Math.min(1, Math.abs(mod.amount)), every: mod.every ?? 1, decayMs: mod.releaseMs ?? 180 };
  const base = v.base;
  return { mode: base > m.spec.min ? "on" : "off", strength: base > m.spec.min ? (base - m.spec.min) / range : DEFAULT_STRENGTH, every: 1, decayMs: 180 };
}

/** Writes a hit state into a post's main parameter (other params untouched). */
export function writeHit(post: EditPost, specs: Record<string, ParamSpec>, h: HitState): EditPost {
  const m = mainParam(specs);
  if (!m) return post;
  const range = m.spec.max - m.spec.min || 1;
  let value: EditParam;
  if (h.mode === "off") value = m.spec.min;
  else if (h.mode === "on") value = round(m.spec.min + h.strength * range);
  else {
    const mod: EditMod = { signal: `marker.${h.mode}`, amount: round(h.strength), shape: "exp", attackMs: 5, releaseMs: h.decayMs };
    if (h.every > 1) mod.every = h.every;
    value = { base: m.spec.min, mods: [mod] };
  }
  const extra = triggerParams(post, specs);
  return { ...post, params: { ...post.params, ...extra, [m.name]: value } };
}

/** Effects with a "trigger"/"source" switch must read the amount for hits to work (shake, chromatic, glitch). */
function triggerParams(post: EditPost, specs: Record<string, ParamSpec>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["trigger", "source"]) {
    const s = specs[k];
    if (s && s.kind === "enum" && s.options.includes("amount") && post.params[k] !== "amount") out[k] = "amount";
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
