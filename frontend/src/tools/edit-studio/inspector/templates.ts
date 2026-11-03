/**
 * Effect templates and Looks (Phase 9 SPEC §9.1). A template makes a ready
 * EditPost with a fresh ID; a Look is a `grade` preset kept in the Look stack
 * under a fixed ID so the preset select can tell which one is applied.
 */
import { newId } from "../doc";
import type { EditMod, EditPost, EditSignalId } from "@/viz/edit/types";

const mod = (signal: EditSignalId, amount: number, attackMs: number, releaseMs: number, shape: EditMod["shape"] = "exp"): EditMod => ({
  signal,
  amount,
  shape,
  attackMs,
  releaseMs,
});

const reactive = (m: EditMod): { base: number; mods: EditMod[] } => ({ base: 0, mods: [m] });

export interface EffectTemplate {
  id: string;
  label: string;
  /** A fresh effect (new ID, enabled). */
  make(): EditPost;
}

export const EFFECT_TEMPLATES: readonly EffectTemplate[] = [
  {
    id: "zoom-punch-kicks",
    label: "Zoom punch on kicks",
    make: () => ({ id: newId("fx"), type: "punch", enabled: true, params: { amount: reactive(mod("marker.kick", 1, 5, 160)) } }),
  },
  {
    id: "flash-drops",
    label: "Flash on drops",
    make: () => ({ id: newId("fx"), type: "flash", enabled: true, params: { amount: reactive(mod("marker.drop", 1, 5, 250)) } }),
  },
  {
    id: "shake-snares",
    label: "Shake on snares",
    make: () => ({ id: newId("fx"), type: "shake", enabled: true, params: { trigger: "amount", amount: reactive(mod("marker.snare", 0.7, 5, 140)) } }),
  },
  {
    id: "rgb-split-hats",
    label: "RGB split on hats",
    make: () => ({ id: newId("fx"), type: "chromatic", enabled: true, params: { source: "amount", amount: reactive(mod("marker.hats", 0.3, 5, 90)) } }),
  },
  {
    id: "glitch-drop",
    label: "Glitch on the drop",
    make: () => ({ id: newId("fx"), type: "glitch", enabled: true, params: { trigger: "amount", amount: reactive(mod("marker.drop", 0.9, 5, 400)) } }),
  },
  {
    id: "blur-pulse-beats",
    label: "Blur pulse on beats",
    make: () => ({ id: newId("fx"), type: "blurpulse", enabled: true, params: { amount: reactive(mod("marker.beat", 0.8, 5, 200)) } }),
  },
  {
    id: "exposure-downbeats",
    label: "Exposure pulse on downbeats",
    make: () => ({ id: newId("fx"), type: "exposure", enabled: true, params: { amount: reactive(mod("marker.downbeat", 0.6, 5, 220)) } }),
  },
  {
    id: "invert-stops",
    label: "Invert on stops",
    make: () => ({ id: newId("fx"), type: "invert", enabled: true, params: { amount: reactive(mod("marker.stop", 1, 5, 60, "gate")) } }),
  },
];

// ---- looks ----

export const LOOK_IDS = ["none", "vivid", "warm", "cool", "mono", "fade", "noir"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export interface LookPreset {
  id: LookId;
  label: string;
  /** `grade` values; null for "none" (no grade). */
  grade: GradeValues | null;
}

export interface GradeValues {
  lift: number;
  gamma: number;
  gain: number;
  saturation: number;
  warmth: number;
}

const GRADE_DEFAULT: GradeValues = { lift: 0, gamma: 1, gain: 1, saturation: 1.1, warmth: 0 };

export const LOOKS: readonly LookPreset[] = [
  { id: "none", label: "None", grade: null },
  { id: "vivid", label: "Vivid", grade: { ...GRADE_DEFAULT, saturation: 1.35, gain: 1.05 } },
  { id: "warm", label: "Warm", grade: { ...GRADE_DEFAULT, warmth: 0.5 } },
  { id: "cool", label: "Cool", grade: { ...GRADE_DEFAULT, warmth: -0.5 } },
  { id: "mono", label: "Mono", grade: { ...GRADE_DEFAULT, saturation: 0 } },
  { id: "fade", label: "Fade", grade: { ...GRADE_DEFAULT, lift: 0.06, gain: 0.9, saturation: 0.8 } },
  { id: "noir", label: "Noir", grade: { ...GRADE_DEFAULT, saturation: 0, gamma: 1.2, gain: 1.15 } },
];

/** The ID of the grade a Look preset owns in the Look stack. */
export const LOOK_GRADE_ID = "look-grade";

/** The Look stack with `id` applied: the preset's grade goes first; "none" removes it. Other effects stay. */
export function applyLook(posts: readonly EditPost[], id: LookId): EditPost[] {
  const rest = posts.filter((p) => p.id !== LOOK_GRADE_ID);
  const preset = LOOKS.find((l) => l.id === id);
  if (!preset?.grade) return rest;
  return [{ id: LOOK_GRADE_ID, type: "grade", enabled: true, params: { ...preset.grade } }, ...rest];
}

/** Which preset the Look stack shows: "none" without a preset grade, "custom" once its values were edited. */
export function currentLook(posts: readonly EditPost[]): LookId | "custom" {
  const g = posts.find((p) => p.id === LOOK_GRADE_ID && p.type === "grade");
  if (!g) return "none";
  for (const l of LOOKS) {
    if (!l.grade) continue;
    const same = (Object.keys(l.grade) as Array<keyof GradeValues>).every((k) => g.params[k] === l.grade?.[k]);
    if (same) return l.id;
  }
  return "custom";
}
