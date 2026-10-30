/** Frame Pulse (SPEC.md §6.10 #20, overlay): a glowing frame that pulses on the beat, sparks from the corners and karaoke captions. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const backdrop = BG("backdrop", "gradient", { speed: 0.4, intensity: 0.7, contrast: 0.5, brightness: P(0.04, m("section.energy", 0.012)), drift: P(0.25, m("bass.level", 0.3)) });

const frame = (thickness: number, glow: number, corners: boolean, chase: number) =>
  L("frame", "frame", {
    thickness: P(thickness, m("kick", 0.15, "exp")),
    glow: P(glow, m("beat.pulse", 0.2)),
    pulse: P(0.8, m("section.energy", 0.2)),
    cornersOnly: corners,
    cornerLength: 0.16,
    chase,
    haze: 0.25,
    brightness: P(0.95, m("section.energy", 0.12)),
  });

const sparks = (count: number, size: number) =>
  L("sparks", "bursts", { kick: true, snare: true, hats: false, bass: false, vocals: false, other: false, origin: "sides", count, speed: 0.9, spread: 0.7, trail: 0.4, gravity: 0.2, life: 1.2, size, glow: 0.55, brightness: 1.5 }, { opacity: 0.85 });

export const framePulse: Preset = {
  id: "frame-pulse",
  name: "Frame Pulse",
  description: "A glowing frame that beats with the music, sparks flying from the sides and karaoke captions. Made for clips and reels.",
  bestFor: "Music clips, reels",
  overlayFirst: true,
  show: makeShow({
    id: "frame-pulse",
    name: "Frame Pulse",
    palette: { mode: "fixed", ids: ["neon"] },
    scenes: [
      S("calm", "Calm", [backdrop, frame(4, 0.45, true, 0.4), sparks(10, 0.7)]),
      S("main", "Main", [backdrop, frame(5, 0.55, false, 0.8), sparks(18, 0.85)]),
      S("full", "Full", [
        backdrop,
        frame(7, 0.7, false, 1.4),
        sparks(28, 1),
        L("pulse", "shockwave", { trigger: "drop+downbeat", strength: 0.6, flash: 0.1, brightness: 1.2 }),
      ]),
    ],
    post: globalPost({ bloom: P(0.5, m("kick", 0.1, "exp"), m("drop.pulse", 0.15)), vignette: 0.3, grain: 0.06 }),
    controls: [
      { label: "Frame glow", target: "frame.glow" },
      { label: "Frame thickness", target: "frame.thickness" },
      { label: "Beat pulse", target: "frame.pulse" },
      { label: "Frame chase", target: "frame.chase" },
      { label: "Sparks", target: "sparks.count" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("karaoke", { size: 5.5, position: "lower", weight: 900, glow: 0.4, outline: 0.07, uppercase: true, showNext: false }),
    director: director(),
  }),
};
