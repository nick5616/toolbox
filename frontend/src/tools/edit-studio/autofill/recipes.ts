/** The auto-fill presets (Phase 9 SPEC §13.3). */
import type { EditParam, EditPost } from "@/viz/edit/types";
import type { Recipe } from "./types";

/** A param driven by a marker lane: base 0 plus one exponential pulse per marker. */
function pulse(signal: "marker.kick" | "marker.drop", releaseMs: number): EditParam {
  return { base: 0, mods: [{ signal, amount: 1, shape: "exp", attackMs: 5, releaseMs }] };
}

const punchOnKick = (): EditPost => ({ id: "fx-punch-kick", type: "punch", enabled: true, params: { amount: pulse("marker.kick", 160) } });
const punchOnDrop = (): EditPost => ({ id: "fx-punch-drop", type: "punch", enabled: true, params: { amount: pulse("marker.drop", 250) } });
const flashOnDrop = (): EditPost => ({ id: "fx-flash-drop", type: "flash", enabled: true, params: { amount: pulse("marker.drop", 250) } });

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
];
