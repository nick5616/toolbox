/** Particle Storm (SPEC.md §6.10 #11): every instrument fires its own coloured particles, with trails. Shows what the stems hear. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", { speed: 0.4, intensity: 0.7, contrast: 0.5, brightness: P(bright, m("section.energy", 0.015)), drift: P(0.3, m("other.level", 0.3)) });

interface Sources {
  kick: boolean;
  snare: boolean;
  hats: boolean;
  bass: boolean;
  vocals: boolean;
  other: boolean;
}

const storm = (src: Sources, count: number, speed: number, size: number, life: number) =>
  L("storm", "bursts", {
    ...src,
    count: P(count, m("section.energy", 0.12)),
    speed: P(speed, m("drums.level", 0.2)),
    spread: 1,
    trail: P(0.6, m("section.energy", 0.1)),
    gravity: 0.3,
    life,
    size,
    glow: 0.65,
    brightness: 1.6,
    origin: "scatter",
  });

export const particleStorm: Preset = {
  id: "particle-storm",
  name: "Particle Storm",
  description: "Kick, snare, hats, bass, voice and other instruments each fire their own colour of sparks and leave trails.",
  bestFor: "Busy mixes; shows the stems",
  show: makeShow({
    id: "particle-storm",
    name: "Particle Storm",
    palette: { mode: "fixed", ids: ["candy"] },
    scenes: [
      S("calm", "Calm", [bg(0.04), storm({ kick: true, snare: false, hats: false, bass: false, vocals: true, other: false }, 14, 0.7, 0.9, 2)]),
      S("main", "Main", [bg(0.05), storm({ kick: true, snare: true, hats: false, bass: true, vocals: true, other: false }, 24, 1, 1, 1.6)], [X("trails", "feedback", { decay: 0.55, zoom: 0.004, rotate: 0 })]),
      S(
        "full",
        "Full",
        [
          bg(0.06),
          storm({ kick: true, snare: true, hats: true, bass: true, vocals: true, other: true }, 36, 1.3, 1.1, 1.5),
          L("pulse", "shockwave", { trigger: "drop", strength: 0.8, flash: 0.15, brightness: 1.4 }),
        ],
        [X("trails", "feedback", { decay: 0.7, zoom: 0.005, rotate: 0.002 })],
      ),
    ],
    // The feedback trails sit in the scenes' own post chains so the captions stay crisp.
    post: globalPost({ bloom: P(0.55, m("drop.pulse", 0.15), m("snare", 0.05, "exp")), vignette: 0.4, grain: 0.08 }),
    controls: [
      { label: "Particles", target: "storm.count" },
      { label: "Particle size", target: "storm.size" },
      { label: "Burst speed", target: "storm.speed" },
      { label: "Spread", target: "storm.spread" },
      { label: "Gravity", target: "storm.gravity" },
      { label: "Trails", target: "storm.trail" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.55 }),
    director: director(),
  }),
};
