/** Synthwave (SPEC.md §6.10 #4): a huge sliced sun, spectrum mountains and a terrain; the sun swells with the kick and only a drop splits the picture. */
import type { Preset } from "./types";
import { BG, L, duck, groove, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const grid = (bright: number, speed: number, sunSize: number, sun: number, mountains: number) =>
  BG("grid", "synthgrid", {
    brightness: P(bright, m("section.energy", 0.05), m("drop.pulse", 0.08)),
    // the shader swells the sun on the kick by itself (scaled by sunPulse), so the preset adds nothing on top
    gridSpeed: P(speed * 0.5, m("section.energy", 0.1, "linear", 600, 1500), m("drums.level", 0.15, "ease", 150, 700)),
    sunSize,
    sunPulse: sun,
    mountains: P(mountains, m("other.level", 0.25, "ease", 600, 1500)),
    horizon: 0.46,
  });

export const synthwave: Preset = {
  id: "synthwave",
  name: "Synthwave",
  description: "A striped retro sun over spectrum mountains and a rolling terrain; the sun swells with the kick and a drop splits the colours.",
  bestFor: "Synthpop, retrowave",
  show: makeShow({
    id: "synthwave",
    name: "Synthwave",
    palette: { mode: "fixed", ids: ["synthwave"] },
    scenes: [
      S("calm", "Calm", [grid(0.6, 0.4, 0.3, 0.5, 0.8)]),
      S("main", "Main", [
        grid(0.7, 0.9, 0.3, 0.7, 1),
        L("hills", "terrain", { rows: 24, height: P(0.35, groove("bass.level", 0.1)), horizon: 0.6, fill: 0.1, brightness: 0.5, mirror: false }, { opacity: P(0.4, duck()) }),
      ]),
      S("full", "Full", [
        grid(0.78, 1.5, 0.34, 0.9, 1.3),
        L("hills", "terrain", { rows: 30, height: P(0.55, groove("bass.level", 0.12)), horizon: 0.6, fill: 0.2, brightness: 0.6, mirror: false }, { opacity: P(0.55, duck()) }),
        L("pulse", "ripples", { trigger: "downbeat", maxRadius: 1, rings: 1, width: 0.004, brightness: 0.8, color: "accent" }, { opacity: 0.55 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.5, groove("bass.level", 0.06), m("drop.pulse", 0.12)),
      vignette: 0.4,
      grain: 0.12,
      extra: [X("chroma", "chromatic", { amount: 5, source: "drop" })],
    }),
    controls: [
      { label: "Sun pulse", target: "grid.sunPulse" },
      { label: "Floor speed", target: "grid.gridSpeed" },
      { label: "Mountains", target: "grid.mountains" },
      { label: "Terrain height", target: "hills.height" },
      { label: "Drop split", target: "post.chroma.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.7 }),
    director: director(),
  }),
};
