/** Night Terrain (SPEC.md §6.10 #14): lines of terrain under a drifting sky of stars and a soft moon glow. Slow and warm. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const sky = (bright: number) =>
  BG("sky", "gradient", { speed: 0.2, intensity: 0.6, contrast: 0.45, brightness: P(bright, m("section.energy", 0.012)), drift: 0.15 });

const terrain = (rows: number, height: number, bright: number, speed: number) =>
  L("land", "terrain", {
    rows,
    height: P(height, m("mix.level", 0.2), m("bass.level", 0.15)),
    speed,
    horizon: 0.58,
    fill: 1,
    brightness: P(bright, m("section.energy", 0.1)),
    mirror: false,
  });

const stars = (density: number, speed: number) =>
  L("stars", "starfield", { density, speed: P(speed, m("section.energy", 0.3)), warp: P(0.05, m("drop.pulse", 0.25)), brightness: 0.55, size: 0.8 }, { opacity: 0.7 });

const moon = (amount: number) => L("moon", "motif", { motif: "night", amount: P(amount, m("section.energy", 0.1)), intensity: 1, speed: 0.6, tint: 0.2 }, { opacity: 0.9 });

export const nightTerrain: Preset = {
  id: "night-terrain",
  name: "Night Terrain",
  description: "Rolling lines of terrain under a slow night sky of stars and a soft moon glow.",
  bestFor: "Lo-fi, chill",
  show: makeShow({
    id: "night-terrain",
    name: "Night Terrain",
    palette: { mode: "fixed", ids: ["galaxy"] },
    scenes: [
      S("calm", "Calm", [sky(0.035), stars(0.3, 0.2), moon(0.6), terrain(30, 0.55, 0.7, 0.5)]),
      S("main", "Main", [sky(0.04), stars(0.45, 0.4), moon(0.7), terrain(40, 0.8, 0.85, 0.9)]),
      S("full", "Full", [sky(0.05), stars(0.6, 0.7), moon(0.9), terrain(56, 1.1, 1, 1.4)]),
    ],
    post: globalPost({ bloom: P(0.55, m("section.energy", 0.05), m("drop.pulse", 0.1)), vignette: 0.5, grain: 0.14 }),
    controls: [
      { label: "Terrain height", target: "land.height" },
      { label: "Scroll speed", target: "land.speed" },
      { label: "Line glow", target: "land.brightness" },
      { label: "Star density", target: "stars.density" },
      { label: "Moon glow", target: "moon.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("fade", { size: 6, position: "lower", showNext: false, glow: 0.4, uppercase: false, weight: 700 }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 2500 }, chorusAfterLift: { kind: "crossfade", ms: 2500 } } }),
  }),
};
