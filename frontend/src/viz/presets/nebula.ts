/** Nebula (SPEC.md §6.10 #3): drifting cosmic clouds, fireflies and the vocal melody drawn as a ribbon. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const cloud = (bright: number, warp: number, speed: number) =>
  BG("cloud", "nebula", {
    brightness: P(bright, m("section.energy", 0.07), m("drop.pulse", 0.1, "exp")),
    warp: P(warp, m("bass.level", 0.3), m("other.level", 0.15)),
    sparkle: P(0.55, m("hats", 0.5, "exp")),
    speed,
    drift: 0.6,
    detail: 5,
  });

export const nebula: Preset = {
  id: "nebula",
  name: "Nebula",
  description: "Slow cosmic clouds that change colour with the chords, drifting fireflies and a ribbon that traces the melody.",
  bestFor: "Ambient, ballads, cinematic",
  show: makeShow({
    id: "nebula",
    name: "Nebula",
    palette: { mode: "chords", ids: ["galaxy"] },
    scenes: [
      S("calm", "Calm", [
        cloud(0.32, 0.45, 0.6),
        L("flies", "fireflies", { count: 40, size: 1, glow: 0.55, brightness: 1.3 }, { opacity: 0.8 }),
        L("melody", "pitchribbon", { staff: false, glow: 0.6, brightness: 1.3, width: P(0.012, m("vocals.level", 0.012)) }, { opacity: 0.7 }),
      ]),
      S("main", "Main", [
        cloud(0.38, 0.65, 1),
        L("flies", "fireflies", { count: P(80, m("vocals.level", 0.15)), size: 1.1, glow: P(0.6, m("vocals.level", 0.3)), brightness: 1.5 }),
        L("melody", "pitchribbon", { staff: true, glow: 0.65, brightness: 1.7, width: P(0.014, m("vocals.level", 0.016), m("vocals.held", 0.01)) }),
      ]),
      S("full", "Full", [
        cloud(0.46, 0.85, 1.4),
        L("flies", "fireflies", { count: P(130, m("mix.level", 0.2)), size: 1.3, glow: P(0.7, m("vocals.level", 0.3)), bokeh: 0.7, brightness: 1.8 }),
        L("rays", "lightrays", { rays: 16, length: 1.1, brightness: P(0.35, m("vocals.held", 0.3), m("beat.pulse", 0.08)), held: 0.9, y: 1.15 }, { opacity: 0.8 }),
        L("melody", "pitchribbon", { staff: true, glow: 0.8, brightness: 2.1, width: P(0.016, m("vocals.level", 0.02), m("vocals.held", 0.01)) }),
      ]),
    ],
    post: globalPost({ bloom: P(0.8, m("section.energy", 0.2)), vignette: 0.45, grain: 0.12 }),
    controls: [
      { label: "Cloud brightness", target: "cloud.brightness" },
      { label: "Cloud swirl", target: "cloud.warp" },
      { label: "Star sparkle", target: "cloud.sparkle" },
      { label: "Fireflies", target: "flies.count" },
      { label: "Melody ribbon", target: "melody.width" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("rise", { size: 6, position: "lower", glow: 0.7, showNext: false }),
    director: director(),
  }),
};
