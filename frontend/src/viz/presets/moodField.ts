/** Mood Field (SPEC.md §6.10 #18): a gradient field whose colour, scene and imagery follow what the words feel and talk about. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, globalPost, text } from "./kit";

const field = (bright: number) =>
  BG("field", "gradient", {
    speed: P(0.4, m("mood.energy", 0.4)),
    intensity: 0.8,
    contrast: 0.45,
    brightness: P(bright, m("mood.energy", 0.02), m("mood.valence", 0.015)),
    drift: P(0.25, m("mood.energy", 0.4), m("vocals.level", 0.15)),
  });

const dust = (count: number) => L("dust", "fireflies", { count: P(count, m("vocals.level", 0.1)), size: 0.9, glow: P(0.5, m("vocals.level", 0.25)), bokeh: 0.4, brightness: 1.3 }, { opacity: 0.8 });

export const moodField: Preset = {
  id: "mood-field",
  name: "Mood Field",
  description: "Colour and scene follow the feeling of the words, and what they talk about (fire, rain, stars, the sea) appears on screen.",
  bestFor: "Songs with strong imagery; spoken word",
  show: makeShow({
    id: "mood-field",
    name: "Mood Field",
    palette: { mode: "mood", ids: ["arctic"] },
    mix: { mood: 1.3, words: 1.2 },
    motifs: true,
    scenes: [
      S("calm", "Calm", [field(0.045), dust(25)]),
      S("main", "Main", [field(0.055), dust(45), L("words", "ripples", { trigger: "word", every: 4, maxRadius: 0.3, rings: 1, width: 0.003, brightness: 0.6, scatter: true, color: "accent" }, { opacity: 0.4 })]),
      S("full", "Full", [
        field(0.065),
        dust(70),
        L("words", "ripples", { trigger: "word", every: 2, maxRadius: 0.55, rings: 1, width: 0.005, brightness: 1, scatter: true, color: "accent" }, { opacity: 0.65 }),
        L("embers", "embers", { count: 90, rise: 0.8, size: 0.8, brightness: 1.3 }, { opacity: 0.7 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.5, m("mood.energy", 0.1), m("drop.pulse", 0.1)),
      vignette: 0.45,
      grain: 0.1,
      extra: [X("mood", "grade", { saturation: P(1, m("mood.energy", 0.4)), gain: P(1, m("mood.valence", 0.2)), gamma: 1, warmth: P(0, m("mood.valence", 0.35)) })],
    }),
    controls: [
      { label: "Field drift", target: "field.drift" },
      { label: "Field brightness", target: "field.brightness" },
      { label: "Dust", target: "dust.count" },
      { label: "Word ripples", target: "words.maxRadius" },
      { label: "Mood colour", target: "post.mood.saturation" },
      { label: "Mood warmth", target: "post.mood.warmth" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("rise", { size: 6.5, position: "lower", glow: 0.55, uppercase: false, weight: 700, showNext: false }),
    director: {
      follow: "emotion",
      sceneFor: { intro: "calm", outro: "calm", bridge: "calm", break: "calm", verse: "main", section: "main", chorus: "full", drop: "full" },
      sceneForEmotion: { joy: "full", love: "main", sadness: "calm", anger: "full", fear: "main", calm: "calm", hope: "main", awe: "full" },
      transitions: { section: { kind: "crossfade", ms: 2400 }, drop: { kind: "flash", ms: 1000 } },
    },
  }),
};
