/** Clean Captions (SPEC.md §6.10 #19, overlay): no background, just readable subtitles that pop on emphasis in the mood colour, with tiny sparks. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

// The dim gradient is dropped in "Over the video" mode; on its own it keeps the captions readable.
const backdrop = BG("backdrop", "gradient", { speed: 0.25, intensity: 0.6, contrast: 0.4, brightness: P(0.05, m("mood.energy", 0.015)), drift: 0.15 });

const sparks = (count: number, size: number, opacity: number) =>
  L("sparks", "bursts", { kick: false, snare: false, hats: false, bass: false, vocals: true, other: false, origin: "scatter", count, speed: 0.7, spread: 0.6, trail: 0.3, gravity: 0.35, life: 1.1, size: P(size, m("word.emphasis", 0.25), m("vocals.level", 0.1)), glow: P(0.5, m("word.pulse", 0.3)), brightness: 1.4 }, { opacity });

export const cleanCaptions: Preset = {
  id: "clean-captions",
  name: "Clean Captions",
  description: "Readable subtitles that pop on important words in the mood colour, with a few tiny sparks. Made to sit over a video.",
  bestFor: "Talking-head videos with subtitles",
  overlayFirst: true,
  show: makeShow({
    id: "clean-captions",
    name: "Clean Captions",
    palette: { mode: "mood", ids: ["dawn"] },
    scenes: [
      S("calm", "Calm", [backdrop, sparks(8, 0.6, 0.7)]),
      S("main", "Main", [backdrop, sparks(12, 0.7, 0.85)]),
      S("full", "Full", [backdrop, sparks(18, 0.8, 1)]),
    ],
    post: globalPost({ bloom: P(0.35, m("word.emphasis", 0.15)), vignette: 0.2, grain: 0.04 }),
    controls: [
      { label: "Spark size", target: "sparks.size" },
      { label: "Spark amount", target: "sparks.count" },
      { label: "Spark glow", target: "sparks.glow" },
      { label: "Backdrop brightness", target: "backdrop.brightness" },
      { label: "Glow on emphasis", target: "post.bloom.intensity" },
    ],
    text: text("subtitle", { size: 5, position: "lower", weight: 700, outline: 0.1, glow: 0.15, uppercase: false, color: "#ffffff", highlight: "mood", emphasis: { scale: 1.3, glow: 0.7, color: "mood", sparks: true }, react: { signal: "word.emphasis", amount: 0.3 } }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 1500 }, chorusAfterLift: { kind: "crossfade", ms: 1500 }, drop: { kind: "crossfade", ms: 1500 } } }),
  }),
};
