/** Oscilloscope Lab (SPEC.md §6.10 #15): phosphor-green scope traces, Lissajous figures and a helix that follow the left and right channels. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", { speed: 0.2, intensity: 0.5, contrast: 0.5, brightness: P(bright, m("section.energy", 0.01)), drift: 0.15 });

const scope = (mode: "line" | "xy", gain: number, persistence: number, scale: number) =>
  L("scope", "oscilloscope", {
    mode,
    gain: P(gain, m("mix.level", 0.12), m("kick", 0.06, "exp")),
    persistence,
    thickness: 0.0045,
    glow: P(0.65, m("beat.pulse", 0.15)),
    brightness: 1.5,
    scale,
    grid: true,
    color: "c0",
  });

const lissa = (layers: number, size: number) =>
  L("lissa", "lissajous", {
    layers,
    freq: P(3, m("vocals.pitch", 0.2)),
    pitchMod: 0.7,
    phaseDrift: P(0.5, m("hats", 0.4, "exp")),
    size: P(size, m("bass.level", 0.06)),
    thickness: 0.004,
    glow: 0.6,
    brightness: 1.3,
    color: "c1",
  }, { opacity: 0.85 });

const helix = (amp: number) =>
  L("helix", "helix", { turns: 2.5, amplitude: P(amp, m("bass.level", 0.2)), rungs: 36, thickness: 0.005, glow: 0.55, brightness: 1.2, color: "c2", scale: 0.9 }, { opacity: 0.7 });

export const oscilloscopeLab: Preset = {
  id: "oscilloscope-lab",
  name: "Oscilloscope Lab",
  description: "A glowing phosphor scope with Lissajous figures and a helix that trace the left and right channels.",
  bestFor: "Electronic, experimental",
  show: makeShow({
    id: "oscilloscope-lab",
    name: "Oscilloscope Lab",
    palette: { mode: "fixed", ids: ["matrix"] },
    scenes: [
      S("calm", "Calm", [bg(0.03), scope("line", 0.8, 0.7, 1)]),
      S("main", "Main", [bg(0.035), scope("xy", 0.8, 0.75, 0.9), lissa(2, 0.3)]),
      S("full", "Full", [bg(0.04), scope("xy", 0.9, 0.82, 1), lissa(3, 0.3), helix(0.22)]),
    ],
    post: globalPost({ bloom: P(0.6, m("kick", 0.1, "exp"), m("drop.pulse", 0.15)), vignette: 0.5, grain: 0.12 }),
    controls: [
      { label: "Scope gain", target: "scope.gain" },
      { label: "Phosphor trail", target: "scope.persistence" },
      { label: "Scope glow", target: "scope.glow" },
      { label: "Figure size", target: "lissa.size" },
      { label: "Figure drift", target: "lissa.phaseDrift" },
      { label: "Helix width", target: "helix.amplitude" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("typewriter", { size: 5.5, position: "lower", showNext: false, glow: 0.5, uppercase: true, weight: 700 }),
    director: director(),
  }),
};
