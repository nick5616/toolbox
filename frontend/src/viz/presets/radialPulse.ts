/** Radial Pulse (SPEC.md §6.10 #6): bars around a centre glow that punches on the kick; ripples and downbeat shockwaves as it grows. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", {
    speed: 0.4,
    intensity: 0.7,
    contrast: 0.45,
    brightness: P(bright, m("section.energy", 0.015), m("bass.level", 0.012)),
    drift: P(0.25, m("mood.energy", 0.3)),
  });

const radial = (count: number, inner: number, length: number, glow: number, scale: number, thick: number) =>
  L("radial", "radial", {
    count,
    innerR: P(inner, m("kick", 0.05, "exp")),
    length: P(length, m("drums.level", 0.04), m("vocals.level", 0.03)),
    thickness: thick,
    spin: 0.12,
    centerGlow: P(glow, m("kick", 0.15, "exp"), m("bass.level", 0.04)),
    scale,
    glow: P(0.3, m("beat.pulse", 0.12)),
    brightness: 1.15,
  });

export const radialPulse: Preset = {
  id: "radial-pulse",
  name: "Radial Pulse",
  description: "A ring of bars around a centre glow that punches with the kick, with ripples and shockwaves as the song builds.",
  bestFor: "EDM, hip-hop",
  show: makeShow({
    id: "radial-pulse",
    name: "Radial Pulse",
    palette: { mode: "fixed", ids: ["neon"] },
    scenes: [
      S("calm", "Calm", [bg(0.04), radial(96, 0.2, 0.08, 0.04, 0.85, 0.5)]),
      S("main", "Main", [
        bg(0.05),
        radial(144, 0.2, 0.11, 0.08, 0.95, 0.55),
        L("ripples", "ripples", { trigger: "kick", every: 2, maxRadius: 0.8, rings: 1, width: 0.005, brightness: 1.0, color: "accent" }, { opacity: 0.7 }),
      ]),
      S("full", "Full", [
        bg(0.06),
        radial(200, 0.22, 0.13, 0.12, 1, 0.6),
        L("ripples", "ripples", { trigger: "kick", every: 1, maxRadius: 1, rings: 2, width: 0.006, brightness: 1.2, color: "accent" }, { opacity: P(0.7, m("kick", 0.15, "exp")) }),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 0.9, flash: 0.15, brightness: 1.5 }),
      ]),
    ],
    post: globalPost({ bloom: P(0.55, m("kick", 0.12, "exp"), m("drop.pulse", 0.15)), vignette: 0.4, grain: 0.1 }),
    controls: [
      { label: "Bar length", target: "radial.length" },
      { label: "Centre glow", target: "radial.centerGlow" },
      { label: "Ring size", target: "radial.innerR" },
      { label: "Bar glow", target: "radial.glow" },
      { label: "Kick ripples", target: "ripples.maxRadius" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6, position: "lower", glow: 0.5 }),
    director: director(),
  }),
};
