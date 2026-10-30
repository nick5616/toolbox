/** Synthwave (SPEC.md §6.10 #4): a huge sliced sun, spectrum mountains and a terrain, with a chromatic jolt on every snare. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const grid = (bright: number, speed: number, sunSize: number, sun: number, mountains: number) =>
  BG("grid", "synthgrid", {
    brightness: P(bright, m("section.energy", 0.05), m("drop.pulse", 0.1, "exp")),
    gridSpeed: P(speed, m("drums.level", 0.5)),
    sunSize,
    sunPulse: P(sun, m("kick", 0.25, "exp")),
    mountains: P(mountains, m("other.level", 0.35)),
    horizon: 0.46,
  });

export const synthwave: Preset = {
  id: "synthwave",
  name: "Synthwave",
  description: "A striped retro sun over spectrum mountains and a rolling terrain; the picture splits on every snare.",
  bestFor: "Synthpop, retrowave",
  show: makeShow({
    id: "synthwave",
    name: "Synthwave",
    palette: { mode: "fixed", ids: ["synthwave"] },
    scenes: [
      S("calm", "Calm", [grid(0.6, 0.4, 0.3, 0.5, 0.8)]),
      S("main", "Main", [
        grid(0.7, 0.9, 0.3, 0.7, 1),
        L("hills", "terrain", { rows: 24, height: P(0.35, m("mix.level", 0.15), m("bass.level", 0.1)), horizon: 0.6, fill: 0.1, brightness: 0.5, mirror: false }, { opacity: 0.4 }),
      ]),
      S("full", "Full", [
        grid(0.78, 1.5, 0.34, 0.9, 1.3),
        L("hills", "terrain", { rows: 30, height: P(0.55, m("mix.level", 0.2), m("bass.level", 0.15)), horizon: 0.6, fill: 0.2, brightness: 0.6, mirror: false }, { opacity: 0.55 }),
        L("pulse", "ripples", { trigger: "downbeat", maxRadius: 1, rings: 1, width: 0.004, brightness: 0.8, color: "accent" }, { opacity: 0.55 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.5, m("kick", 0.08, "exp"), m("drop.pulse", 0.15)),
      vignette: 0.4,
      grain: 0.12,
      extra: [X("chroma", "chromatic", { amount: 6, source: "snare" })],
    }),
    controls: [
      { label: "Sun pulse", target: "grid.sunPulse" },
      { label: "Floor speed", target: "grid.gridSpeed" },
      { label: "Mountains", target: "grid.mountains" },
      { label: "Terrain height", target: "hills.height" },
      { label: "Snare split", target: "post.chroma.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.7 }),
    director: director(),
  }),
};
