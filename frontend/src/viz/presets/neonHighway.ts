/** Neon Highway (SPEC.md §6.10 #2): a synthwave floor with a note highway whose lanes are the instruments. */
import type { Preset } from "./types";
import { BG, L, duck, groove, m, makeShow, P, S, director, globalPost, text } from "./kit";

// The grid's horizon (0.55 from the bottom) and the highway's vanishing point (0.45 from the top) meet.
const grid = (bright: number, speed: number, sun: number, mountains: number) =>
  BG("grid", "synthgrid", {
    brightness: P(bright, m("section.energy", 0.06), m("drop.pulse", 0.08)),
    gridSpeed: P(speed * 0.5, m("section.energy", 0.1, "linear", 600, 1500), m("drums.level", 0.15, "ease", 150, 700)),
    sunPulse: sun, // the shader swells the sun on the kick by itself
    mountains: P(mountains, m("other.level", 0.25, "ease", 600, 1500)),
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
        L("road", "highway", { lookahead: 4, width: 0.5, horizon: 0.45, glow: 0.4, brightness: 0.7, noteSize: 0.6 }, { opacity: 0.8 }),
      ]),
      S("main", "Main", [
        grid(0.7, 0.8, 0.7, 1),
        L("road", "highway", { lookahead: 4, width: 0.55, horizon: 0.45, glow: P(0.45, groove("beat.pulse", 0.04)), brightness: 0.75, noteSize: 0.6 }),
      ]),
      S("full", "Full", [
        grid(0.8, 1.1, 0.9, 1.3),
        L("stars", "starfield", { density: 0.55, speed: 1, warp: P(0.5, m("drop.pulse", 0.3)), brightness: 0.45, size: 0.8 }, { opacity: P(0.6, duck()) }),
        L("road", "highway", { lookahead: 4, width: 0.6, horizon: 0.45, glow: P(0.5, groove("beat.pulse", 0.04)), brightness: 0.8, noteSize: 0.6 }),
        L("pulse", "ripples", { trigger: "downbeat", maxRadius: 1, rings: 1, width: 0.004, brightness: 0.8, color: "accent" }, { opacity: 0.5 }),
      ]),
    ],
    post: globalPost({ bloom: P(0.55, groove("bass.level", 0.06), m("drop.pulse", 0.12)), vignette: 0.4, grain: 0.1 }),
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
