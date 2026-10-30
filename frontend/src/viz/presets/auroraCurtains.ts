/** Aurora Curtains (SPEC.md §6.10 #12): tall curtains of northern light over a quiet snowfall. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const aurora = (bright: number, height: number, bands: number) =>
  BG("aurora", "aurora", {
    bands,
    style: "curtains",
    tint: 0.3,
    react: 0.7,
    height: P(height, m("other.level", 0.1), m("section.energy", 0.1)),
    brightness: P(bright, m("section.energy", 0.02), m("vocals.level", 0.03), m("drop.pulse", 0.04, "exp")),
  });

const snow = (amount: number, density: number, wind: number) =>
  L("snow", "motif", { motif: "snow", amount: P(amount, m("section.energy", 0.15)), density, wind, speed: 0.8, size: 1, intensity: 1 }, { opacity: 0.9 });

export const auroraCurtains: Preset = {
  id: "aurora-curtains",
  name: "Aurora Curtains",
  description: "Tall curtains of northern light that sway with the music while snow drifts through the dark.",
  bestFor: "Chill, winter, piano",
  show: makeShow({
    id: "aurora-curtains",
    name: "Aurora Curtains",
    palette: { mode: "fixed", ids: ["arctic"] },
    scenes: [
      S("calm", "Calm", [aurora(0.2, 0.8, 3), snow(0.35, 0.6, 0.1)]),
      S("main", "Main", [aurora(0.17, 0.95, 5), snow(0.5, 0.9, 0.2)]),
      S("full", "Full", [
        aurora(0.16, 1.1, 7),
        snow(0.7, 1.2, 0.35),
        L("glints", "fireflies", { count: 50, size: 0.7, glow: 0.45, bokeh: 0.2, brightness: 1.3 }, { opacity: 0.7 }),
      ]),
    ],
    post: globalPost({ bloom: P(0.5, m("section.energy", 0.05), m("drop.pulse", 0.1)), vignette: 0.45, grain: 0.1 }),
    controls: [
      { label: "Curtain height", target: "aurora.height" },
      { label: "Curtain glow", target: "aurora.brightness" },
      { label: "Edge colour", target: "aurora.tint" },
      { label: "Snowfall", target: "snow.amount" },
      { label: "Snow wind", target: "snow.wind" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("fade", { size: 6, position: "lower", showNext: false, glow: 0.4, uppercase: false, weight: 700 }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 2500 }, chorusAfterLift: { kind: "crossfade", ms: 2500 } } }),
  }),
};
