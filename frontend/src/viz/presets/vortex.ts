/** Vortex (SPEC.md §6.10 #16): lines spiral out of the centre, twisting with the bass; polygon rays fire on the kick. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", { speed: 0.4, intensity: 0.7, contrast: 0.5, brightness: P(bright, m("section.energy", 0.012), m("bass.level", 0.012)), drift: P(0.3, m("bass.level", 0.3)) });

const vortex = (lines: number, twist: number, length: number, thick: number) =>
  L("vortex", "vortex", {
    lines,
    twist: P(twist, m("bass.level", 0.3), m("kick", 0.1, "exp")),
    length: P(length, m("drums.level", 0.08)),
    thickness: thick,
    spin: P(0.4, m("section.energy", 0.4)),
    glow: P(0.4, m("beat.pulse", 0.12)),
    color: "c0",
    brightness: 0.8,
  }, { opacity: 0.85 });

const geometry = (shapes: number, size: number, rays: number) =>
  L("geom", "geometry", {
    shapes,
    sides: 6,
    size: P(size, m("kick", 0.06, "exp")),
    roughness: P(0.4, m("snare", 0.3, "exp")),
    rays: P(rays, m("kick", 0.3, "exp")),
    spin: 0.25,
    thickness: 0.004,
    glow: 0.55,
    brightness: 1.3,
  }, { opacity: 0.85 });

export const vortexPreset: Preset = {
  id: "vortex",
  name: "Vortex",
  description: "A whirlpool of light lines that twists harder with the bass, with spinning polygons firing rays on every kick.",
  bestFor: "Heavy, bass music",
  show: makeShow({
    id: "vortex",
    name: "Vortex",
    palette: { mode: "fixed", ids: ["toxic"] },
    scenes: [
      S("calm", "Calm", [bg(0.04), vortex(44, 0.5, 0.3, 0.0025)]),
      S("main", "Main", [bg(0.05), vortex(64, 0.9, 0.36, 0.003), geometry(3, 0.22, 0.4)]),
      S("full", "Full", [
        bg(0.06),
        vortex(96, 1.4, 0.44, 0.0032),
        geometry(5, 0.3, 0.8),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 0.9, flash: 0.2, brightness: 1.5 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.55, m("kick", 0.1, "exp"), m("drop.pulse", 0.15)),
      vignette: 0.45,
      grain: 0.1,
      extra: [X("chroma", "chromatic", { amount: P(3, m("section.energy", 0.2)), source: "kick" })],
    }),
    controls: [
      { label: "Twist", target: "vortex.twist" },
      { label: "Line length", target: "vortex.length" },
      { label: "Spin", target: "vortex.spin" },
      { label: "Shape rays", target: "geom.rays" },
      { label: "Shape size", target: "geom.size" },
      { label: "Kick split", target: "post.chroma.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.55 }),
    director: director(),
  }),
};
