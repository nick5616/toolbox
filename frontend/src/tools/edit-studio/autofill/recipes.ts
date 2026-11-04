/** The auto-fill presets (Phase 9 SPEC §13.3). */
import type { EditParam, EditPost } from "@/viz/edit/types";
import { fxStack } from "../inspector/FxStacks";
import type { Recipe } from "./types";

/** A param driven by a marker lane: base 0 plus one exponential pulse per marker. */
function pulse(signal: "marker.kick" | "marker.drop", releaseMs: number): EditParam {
  return { base: 0, mods: [{ signal, amount: 1, shape: "exp", attackMs: 5, releaseMs }] };
}

const punchOnKick = (): EditPost => ({ id: "fx-punch-kick", type: "punch", enabled: true, params: { amount: pulse("marker.kick", 160) } });
const punchOnDrop = (): EditPost => ({ id: "fx-punch-drop", type: "punch", enabled: true, params: { amount: pulse("marker.drop", 250) } });
const flashOnDrop = (): EditPost => ({ id: "fx-flash-drop", type: "flash", enabled: true, params: { amount: pulse("marker.drop", 250) } });

/** A fresh copy of an FX stack's effects. */
function stack(id: string): EditPost[] {
  return fxStack(id)?.make() ?? [];
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "downbeat",
    name: "Downbeat cuts",
    description: "One cut on every bar, in the order of your sources. Calm and steady.",
    rules: [{ cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" }],
  },
  {
    id: "kick",
    name: "Kick cuts",
    description: "A cut on every kick drum, with shuffled sources and random moments. Fast and busy.",
    rules: [{ cutLane: "kick", minClipMs: 120, sourceOrder: "shuffleNoRepeat", videoIn: "random" }],
  },
  {
    id: "chorus-double",
    name: "Chorus double-time",
    description: "Cuts on every beat in choruses and drops, and on every bar elsewhere.",
    rules: [
      { sections: ["chorus", "drop"], cutLane: "beat", sourceOrder: "shuffleNoRepeat", videoIn: "random" },
      { cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" },
    ],
  },
  {
    id: "hold-verse",
    name: "Hold verse",
    description: "Long holds on each lyric phrase in verses, intros and bridges, kick cuts in choruses and drops, bar cuts elsewhere.",
    rules: [
      { sections: ["verse", "intro", "bridge"], cutLane: "phrase", sourceOrder: "sequential", videoIn: "shotAligned" },
      { sections: ["chorus", "drop"], cutLane: "kick", minClipMs: 200, sourceOrder: "shuffleNoRepeat", videoIn: "random" },
      { cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" },
    ],
  },
  {
    id: "drop-slam",
    name: "Drop slam",
    description: "Kick cuts with a punch in drops, a hero shot with a flash on the drop itself, and a freeze on every stop.",
    rules: [
      { sections: ["drop"], cutLane: "kick", minClipMs: 150, sourceOrder: "shuffleNoRepeat", videoIn: "random", effects: [punchOnKick()] },
      { cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" },
    ],
    onDrop: { tag: "hero", effects: [punchOnDrop(), flashOnDrop()], transition: { kind: "flash", ms: 300 } },
    onStop: "freeze",
  },
  {
    id: "anime-drop",
    name: "Anime drop",
    description: "Bar cuts in verses, kick cuts with the Anime hit stack in drops, and a shockwave with a flash on the drop itself.",
    rules: [
      { sections: ["verse"], cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" },
      { sections: ["drop"], cutLane: "kick", minClipMs: 150, sourceOrder: "shuffleNoRepeat", videoIn: "random", effects: stack("anime-hit") },
      { cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" },
    ],
    onDrop: { tag: "hero", effects: [...stack("drop-impact").filter((e) => e.type !== "zoomblur")] },
  },
  {
    id: "velocity-edit",
    name: "Velocity edit",
    description: "A cut on every beat; each clip slows on its cut and speeds up after it, with a zoom punch and motion blur on the kicks.",
    // A recipe can't carry speed keys (only freezes on stops), so the ramps are applied per clip
    // with Velocity > Ramp into the beat (inspector/velocity.ts); the effects are the recipe's part.
    rules: [{ cutLane: "beat", minClipMs: 250, sourceOrder: "shuffleNoRepeat", videoIn: "random", effects: stack("velocity-punch") }],
  },
];
