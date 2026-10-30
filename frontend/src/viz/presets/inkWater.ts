/** Ink & Water (SPEC.md §6.10 #10): slow metaball ink and soft fireflies; the colour follows the mood of the words. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const ink = (blobs: number, swell: number, bright: number, edge: number) =>
  BG("ink", "ink", {
    blobs,
    viscosity: 0.6,
    swell: P(swell, m("vocals.level", 0.25), m("bass.level", 0.1)),
    speed: P(0.7, m("section.energy", 0.3)),
    brightness: P(bright, m("section.energy", 0.03), m("vocals.level", 0.03)),
    size: P(0.85, m("section.energy", -0.1)),
    edge,
  });

export const inkWater: Preset = {
  id: "ink-water",
  name: "Ink & Water",
  description: "Slow ink blooming in water that swells with the voice and takes the colour of what the words feel like.",
  bestFor: "Ballads, speech, poetry",
  show: makeShow({
    id: "ink-water",
    name: "Ink & Water",
    palette: { mode: "mood", ids: ["arctic"] },
    mix: { mood: 1.2 },
    scenes: [
      S("calm", "Calm", [ink(5, 0.5, 0.38, 0.6), L("flies", "fireflies", { count: 30, size: 0.9, glow: 0.5, brightness: 1.2 }, { opacity: 0.7 })]),
      S("main", "Main", [
        ink(8, 0.8, 0.44, 0.7),
        L("flies", "fireflies", { count: P(60, m("vocals.level", 0.1)), size: 1, glow: P(0.55, m("vocals.level", 0.3)), brightness: 1.4 }),
      ]),
      S("full", "Full", [
        ink(11, 1.1, 0.5, 0.8),
        L("flies", "fireflies", { count: P(100, m("mix.level", 0.12)), size: 1.15, glow: P(0.65, m("vocals.level", 0.3)), bokeh: 0.6, brightness: 1.6 }),
        L("rings", "ripples", { trigger: "word", every: 3, maxRadius: 0.5, rings: 1, width: 0.004, brightness: 0.9, scatter: true, color: "accent" }, { opacity: 0.55 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.5, m("section.energy", 0.05)),
      vignette: 0.5,
      grain: 0.12,
      extra: [X("mood", "grade", { saturation: P(1, m("mood.energy", 0.35)), gain: P(1, m("mood.valence", 0.2)), gamma: 1, warmth: P(0, m("mood.valence", 0.3)) })],
    }),
    controls: [
      { label: "Ink swell", target: "ink.swell" },
      { label: "Ink edge", target: "ink.edge" },
      { label: "Flow speed", target: "ink.speed" },
      { label: "Fireflies", target: "flies.count" },
      { label: "Mood colour", target: "post.mood.saturation" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("fade", { size: 6, position: "lower", showNext: false, glow: 0.45, uppercase: false, weight: 700 }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 2500 }, chorusAfterLift: { kind: "crossfade", ms: 2500 } } }),
  }),
};
