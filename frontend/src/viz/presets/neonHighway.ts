/** Neon Highway (SPEC.md §6.10 #2): a synthwave floor with a note highway whose lanes are the instruments. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

// The grid's horizon (0.55 from the bottom) and the highway's vanishing point (0.45 from the top) meet.
const grid = (bright: number, speed: number, sun: number, mountains: number) =>
  BG("grid", "synthgrid", {
    brightness: P(bright, m("section.energy", 0.06), m("drop.pulse", 0.1, "exp")),
    gridSpeed: P(speed, m("drums.level", 0.35)),
    sunPulse: P(sun, m("kick", 0.2, "exp")),
    mountains: P(mountains, m("other.level", 0.3)),
    sunSize: 0.24,
    horizon: 0.55,
  });

export const neonHighway: Preset = {
  id: "neon-highway",
  name: "Neon Highway",
  description: "A glowing synthwave floor with a note highway: kick, snare, hats, bass and vocals each get a lane.",
  bestFor: "Dance, rock, anything with drums",
  show: makeShow({
    id: "neon-highway",
    name: "Neon Highway",
    palette: { mode: "fixed", ids: ["synthwave"] },
    scenes: [
      S("calm", "Calm", [
        grid(0.6, 0.45, 0.5, 0.7),
        L("road", "highway", { lookahead: 3.4, width: 0.7, horizon: 0.45, glow: 0.45, brightness: 1.1, noteSize: 0.9 }, { opacity: 0.8 }),
      ]),
      S("main", "Main", [
        grid(0.7, 0.9, 0.7, 1),
        L("road", "highway", { lookahead: 2.6, width: 0.85, horizon: 0.45, glow: P(0.5, m("beat.pulse", 0.15)), brightness: 1.4 }),
      ]),
      S("full", "Full", [
        grid(0.8, 1.6, 0.9, 1.3),
        L("stars", "starfield", { density: 0.55, speed: P(1, m("drums.level", 0.4)), warp: P(0.5, m("drop.pulse", 0.5), m("kick", 0.15, "exp")), brightness: 0.45, size: 0.8 }, { opacity: 0.6 }),
        L("road", "highway", { lookahead: 2.2, width: 1, horizon: 0.45, glow: P(0.55, m("beat.pulse", 0.2)), brightness: 1.45, noteSize: 1.15 }),
        L("pulse", "ripples", { trigger: "downbeat", maxRadius: 1, rings: 1, width: 0.004, brightness: 0.8, color: "accent" }, { opacity: 0.6 }),
      ]),
    ],
    post: globalPost({ bloom: P(0.55, m("kick", 0.08, "exp"), m("drop.pulse", 0.15)), vignette: 0.4, grain: 0.1 }),
    controls: [
      { label: "Floor speed", target: "grid.gridSpeed" },
      { label: "Sun pulse", target: "grid.sunPulse" },
      { label: "Mountains", target: "grid.mountains" },
      { label: "Highway glow", target: "road.glow" },
      { label: "Note size", target: "road.noteSize" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.6 }),
    director: director(),
  }),
};
