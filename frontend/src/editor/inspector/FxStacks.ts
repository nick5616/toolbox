/**
 * FX stacks (Part B SPEC §23.8): one click adds several effects with their marker
 * reactions filled in. Param names follow §23.4 and the existing effects; mod
 * amounts are fractions of the parameter's range. Every call makes fresh IDs.
 *
 * Section gating: the song's section labels have no "lift" or "build", so
 * "Strobe build" is gated to the break and bridge sections, where builds sit.
 */
import type { EditMod, EditParam, EditPost, EditSignalId } from "@/viz/edit/types";
import type { PostType } from "@/viz/types";
import { newId } from "@/editor/doc";

function mod(signal: EditSignalId, amount: number, attackMs: number, releaseMs: number, extra: Pick<EditMod, "every" | "sections"> = {}): EditMod {
  return { signal, amount, shape: "exp", attackMs, releaseMs, ...extra };
}

/** A param at `base` with one pulse per marker. */
const pulse = (m: EditMod, base = 0): EditParam => ({ base, mods: [m] });

const post = (type: PostType, params: EditPost["params"]): EditPost => ({ id: newId("fx"), type, enabled: true, params });

export interface FxStack {
  id: string;
  label: string;
  description: string;
  /** Fresh effects (new IDs, enabled). */
  make(): EditPost[];
}

export const FX_STACKS: readonly FxStack[] = [
  {
    id: "anime-hit",
    label: "Anime hit",
    description: "Shake, zoom punch, colour split and a flash on every kick.",
    make: () => [
      post("shake", { trigger: "amount", amount: pulse(mod("marker.kick", 0.8, 5, 160)) }),
      post("punch", { amount: pulse(mod("marker.kick", 1, 5, 160)) }),
      post("chromatic", { source: "amount", amount: pulse(mod("marker.kick", 0.35, 5, 140)) }),
      post("flash", { amount: pulse(mod("marker.kick", 0.3, 3, 90)) }),
    ],
  },
  {
    id: "drop-impact",
    label: "Drop impact",
    description: "A shockwave ring, a zoom blur and a flash on the drop.",
    make: () => [
      post("shockwave", { amount: pulse(mod("marker.drop", 1, 5, 900)), width: 0.08, strength: 0.6 }),
      post("zoomblur", { amount: pulse(mod("marker.drop", 0.8, 5, 450)) }),
      post("flash", { amount: pulse(mod("marker.drop", 1, 5, 250)) }),
    ],
  },
  {
    id: "velocity-punch",
    label: "Velocity punch",
    description: "Zoom punch with motion blur on every kick.",
    make: () => [post("punch", { amount: pulse(mod("marker.kick", 1, 5, 160)) }), post("dirblur", { amount: pulse(mod("marker.kick", 0.6, 5, 150)), angle: 0 })],
  },
  {
    id: "glow-pump",
    label: "Glow pump",
    description: "A soft glow that swells on every kick.",
    make: () => [post("glow", { amount: pulse(mod("marker.kick", 0.5, 5, 220), 0.25) })],
  },
  {
    id: "strobe-build",
    label: "Strobe build",
    description: "A flash on every beat, only in builds (break and bridge sections).",
    make: () => [post("flash", { amount: pulse(mod("marker.beat", 0.7, 3, 90, { sections: ["break", "bridge"] })) })],
  },
  {
    id: "manga",
    label: "Manga",
    description: "Hard black and white, halftone dots and ink outlines.",
    make: () => [
      post("mono", { amount: 1, contrast: 1.2, hard: true }),
      post("halftone", { amount: 0.5, dots: 90, angle: 45, mode: "mono" }),
      post("outline", { amount: 1, thickness: 1, mode: "ink" }),
    ],
  },
  {
    id: "vhs-intro",
    label: "VHS intro",
    description: "Worn tape under cinema bars.",
    make: () => [post("vhs", { amount: 0.8 }), post("letterbox", { amount: 0.6 })],
  },
  {
    id: "speed-lines-drop",
    label: "Speed lines on drop",
    description: "Anime speed lines that burst on the drop and fade out.",
    make: () => [post("speedlines", { amount: pulse(mod("marker.drop", 1, 5, 700)), density: 90, inner: 0.35 })],
  },
  {
    id: "swing-downbeats",
    label: "3D swing on downbeats",
    description: "The picture tilts in 3D on every bar and swings back.",
    make: () => [post("swing", { rotY: pulse(mod("marker.downbeat", 0.15, 8, 500)), rotX: 0, persp: 0.5, mirror: true })],
  },
  {
    id: "slice-hats",
    label: "Slice glitch on hats",
    description: "Sliced, shifted bands on every hi-hat.",
    make: () => [post("slice", { amount: pulse(mod("marker.hats", 0.8, 3, 120)), bands: 12, rgb: 0.3 })],
  },
  {
    id: "duotone-pulse",
    label: "Duotone pulse",
    description: "A two-colour look that pulses in on every kick.",
    make: () => [post("duotone", { amount: pulse(mod("marker.kick", 0.7, 5, 260), 0.3) })],
  },
  {
    id: "light-leak",
    label: "Light leak",
    description: "Warm light drifting over the picture.",
    make: () => [post("lightleak", { amount: 0.55, speed: 0.5 })],
  },
  {
    id: "green-screen",
    label: "Green screen",
    description: "Keys out a green screen, trims the edge a little and removes green spill. Masks still work as garbage mattes.",
    make: () => [post("chromakey", { color: "#00b140", similarity: 0.18, smoothness: 0.08, spill: 0.6, choke: 0.1, view: "composite", amount: 1 })],
  },
];

/** The stack with this ID. */
export function fxStack(id: string): FxStack | undefined {
  return FX_STACKS.find((s) => s.id === id);
}
