/** Spectrum Classic (SPEC.md §6.10 #5): the reference preset. */
import type { Preset } from "./types";

export const spectrumClassic: Preset = {
  id: "spectrum-classic",
  name: "Spectrum Classic",
  description: "Mirrored spectrum bars with falling peaks over a slow gradient.",
  bestFor: "Clean, universal",
  show: {
    version: 1,
    name: "Spectrum Classic",
    presetId: "spectrum-classic",
    scenes: [
      {
        id: "calm",
        name: "Calm",
        layers: [
          { id: "bg", type: "gradient", enabled: true, blend: "normal", opacity: 1, params: { speed: 0.3, intensity: 0.8, brightness: 0.04, contrast: 0.3, drift: { base: 0.2, mods: [{ signal: "mood.energy", amount: 0.3, shape: "ease" }] } } },
          { id: "bars", type: "bars", enabled: true, blend: "add", opacity: 0.8, params: { count: 48, height: { base: 0.35, mods: [{ signal: "mix.level", amount: 0.3, shape: "linear" }] }, glow: 0.4, layout: "mirror" } },
        ],
        post: [],
      },
      {
        id: "main",
        name: "Main",
        layers: [
          { id: "bg", type: "gradient", enabled: true, blend: "normal", opacity: 1, params: { speed: 0.5, intensity: 0.85, brightness: { base: 0.05, mods: [{ signal: "section.energy", amount: 0.02, shape: "linear" }] }, contrast: 0.4, drift: { base: 0.3, mods: [{ signal: "bass.level", amount: 0.4, shape: "ease" }] } } },
          { id: "bars", type: "bars", enabled: true, blend: "add", opacity: 1, params: { count: 64, height: { base: 0.5, mods: [{ signal: "kick", amount: 0.2, shape: "exp" }] }, glow: { base: 0.45, mods: [{ signal: "beat.pulse", amount: 0.3, shape: "linear" }] }, layout: "mirror" } },
        ],
        post: [],
      },
      {
        id: "full",
        name: "Full",
        layers: [
          { id: "bg", type: "gradient", enabled: true, blend: "normal", opacity: 1, params: { speed: 0.8, intensity: 0.9, brightness: { base: 0.07, mods: [{ signal: "bar.pulse", amount: 0.02, shape: "exp" }] }, contrast: 0.5, drift: { base: 0.5, mods: [{ signal: "bass.level", amount: 0.5, shape: "ease" }] } } },
          { id: "bars", type: "bars", enabled: true, blend: "add", opacity: 1, params: { count: 96, height: { base: 0.6, mods: [{ signal: "kick", amount: 0.25, shape: "exp" }] }, glow: { base: 0.6, mods: [{ signal: "beat.pulse", amount: 0.3, shape: "linear" }] }, brightness: 1.8, layout: "reflect", y: 0.3 } },
        ],
        post: [],
      },
    ],
    timeline: { mode: "auto", entries: [] },
    palette: { mode: "fixed", ids: ["cyber"] },
    mix: { drums: 1, bass: 1, vocals: 1, other: 1, words: 1, mood: 1 },
    reactivity: 1,
    speed: 1,
    text: null,
    motifs: false,
    post: [
      { id: "bloom", type: "bloom", enabled: true, params: { intensity: { base: 0.55, mods: [{ signal: "drop.pulse", amount: 0.2, shape: "linear" }] }, threshold: 0.9 } },
      { id: "vignette", type: "vignette", enabled: true, params: { amount: 0.35 } },
      { id: "grain", type: "grain", enabled: true, params: { amount: 0.1 } },
    ],
    controls: [
      { label: "Bar height", target: "bars.height" },
      { label: "Glow", target: "bars.glow" },
      { label: "Background drift", target: "bg.drift" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
  },
};
