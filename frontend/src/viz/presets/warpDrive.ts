/** Warp Drive (SPEC.md §6.10 #8): a starfield that stretches with the drums, flashes on drops and shakes on the kick. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", { speed: 0.5, intensity: 0.75, contrast: 0.5, brightness: P(bright, m("section.energy", 0.015), m("drop.pulse", 0.02, "exp")), drift: P(0.3, m("bass.level", 0.3)) });

const stars = (density: number, speed: number, warp: number, bright: number, size: number) =>
  L("stars", "starfield", {
    density,
    speed: P(speed, m("drums.level", 0.7), m("section.energy", 0.3)),
    warp: P(warp, m("kick", 0.2, "exp"), m("drop.pulse", 0.5), m("lift.pulse", 0.3)),
    brightness: bright,
    size,
  });

export const warpDrive: Preset = {
  id: "warp-drive",
  name: "Warp Drive",
  description: "Stars streak past faster with every drum hit, flash white on drops and the whole frame shakes on the kick.",
  bestFor: "Drum & bass, energetic",
  show: makeShow({
    id: "warp-drive",
    name: "Warp Drive",
    palette: { mode: "fixed", ids: ["ice"] },
    scenes: [
      S("calm", "Calm", [bg(0.04), stars(0.45, 0.35, 0.2, 0.7, 0.9)]),
      S("main", "Main", [bg(0.05), stars(0.6, 0.9, 0.5, 0.7, 1)]),
      S("full", "Full", [
        bg(0.06),
        stars(0.65, 1.5, 0.9, 0.62, 1),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 1, flash: 0.35, brightness: 1.8 }),
        L("sparks", "bursts", { kick: false, snare: true, hats: false, bass: false, vocals: false, other: false, origin: "center", count: 24, speed: 1.4, trail: 0.7, gravity: 0.1, size: 0.8, brightness: 1.4 }, { opacity: 0.8 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.4, m("drop.pulse", 0.15), m("kick", 0.06, "exp")),
      vignette: 0.4,
      grain: 0.08,
      extra: [X("shake", "shake", { amount: P(0.2, m("section.energy", 0.45)) })],
    }),
    controls: [
      { label: "Warp speed", target: "stars.speed" },
      { label: "Warp stretch", target: "stars.warp" },
      { label: "Star density", target: "stars.density" },
      { label: "Drop flash", target: "shock.flash" },
      { label: "Camera shake", target: "post.shake.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.6, uppercase: true }),
    director: director(),
  }),
};
