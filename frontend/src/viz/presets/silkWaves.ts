/** Silk Waves (SPEC.md §6.10 #7): layered ribbons that leave soft trails over a vaporwave gradient. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const bg = (bright: number) =>
  BG("bg", "gradient", { speed: 0.35, intensity: 0.8, contrast: 0.4, brightness: P(bright, m("section.energy", 0.02)), drift: P(0.3, m("mood.energy", 0.3), m("other.level", 0.2)) });

const silk = (layers: number, amp: number, thick: number, glow: number) =>
  L("silk", "ribbons", {
    layers,
    amplitude: P(amp, m("vocals.level", 0.12), m("kick", 0.06, "exp"), m("section.energy", 0.1)),
    thickness: P(thick, m("bass.level", 0.004)),
    speed: P(0.6, m("drums.level", 0.4)),
    trail: P(0.55, m("section.energy", 0.15)),
    glow,
    brightness: 1.25,
  });

export const silkWaves: Preset = {
  id: "silk-waves",
  name: "Silk Waves",
  description: "Flowing ribbons that swell with the voice and trail like silk across a soft vaporwave gradient.",
  bestFor: "Pop, R&B",
  show: makeShow({
    id: "silk-waves",
    name: "Silk Waves",
    palette: { mode: "fixed", ids: ["vaporwave"] },
    scenes: [
      S("calm", "Calm", [bg(0.045), silk(2, 0.22, 0.008, 0.5)]),
      S("main", "Main", [bg(0.055), silk(3, 0.32, 0.01, 0.55)], [X("trails", "feedback", { decay: 0.6, zoom: 0.006, rotate: 0.002 })]),
      S(
        "full",
        "Full",
        [bg(0.065), silk(4, 0.4, 0.012, 0.6), L("sparkle", "fireflies", { count: 60, size: 0.8, glow: 0.5, bokeh: 0.3, brightness: 1.3 }, { opacity: 0.7 })],
        [X("trails", "feedback", { decay: 0.74, zoom: 0.008, rotate: 0.002 })],
      ),
    ],
    // The soft trails live in the scenes' own post chains, so the captions drawn after them stay crisp.
    post: globalPost({ bloom: P(0.5, m("drop.pulse", 0.15), m("section.energy", 0.05)), vignette: 0.4, grain: 0.08 }),
    controls: [
      { label: "Wave height", target: "silk.amplitude" },
      { label: "Ribbon thickness", target: "silk.thickness" },
      { label: "Flow speed", target: "silk.speed" },
      { label: "Ribbon glow", target: "silk.glow" },
      { label: "Soft trails", target: "silk.trail" },
      { label: "Background swirl", target: "bg.drift" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("rise", { size: 6.5, position: "lower", glow: 0.6 }),
    director: director(),
  }),
};
