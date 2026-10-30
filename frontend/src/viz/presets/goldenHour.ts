/** Golden Hour (SPEC.md §6.10 #1): aurora, L/R wave rings, rising embers, kick ripples and a sweep on every new section. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const aurora = (bright: number, height: number, bands: number) =>
  BG("aurora", "aurora", {
    bands,
    style: "curtains",
    tint: 0.4,
    height: P(height, m("vocals.level", 0.25), m("section.energy", 0.3)),
    brightness: P(bright, m("section.energy", 0.05), m("drop.pulse", 0.08, "exp"), m("other.level", 0.04)),
  });

const rings = (radius: number, thick: number, opacity: number) =>
  L(
    "waves",
    "wavering",
    {
      pair: true,
      rings: 2,
      radius: P(radius, m("section.energy", 0.06), m("kick", 0.035, "exp")),
      wobble: P(0.4, m("bass.level", 0.3), m("snare", 0.12, "exp")),
      thickness: thick,
      glow: P(0.55, m("beat.pulse", 0.2)),
      brightness: 1.35,
    },
    { opacity },
  );

export const goldenHour: Preset = {
  id: "golden-hour",
  name: "Golden Hour",
  description: "Aurora curtains, left and right wave rings and rising embers that glow from deep night to a golden dawn.",
  bestFor: "Any song; the party look",
  show: makeShow({
    id: "golden-hour",
    name: "Golden Hour",
    palette: { mode: "journey", ids: ["deep-night", "dawn", "golden", "electric"] },
    scenes: [
      S("calm", "Calm", [
        aurora(0.22, 0.8, 4),
        rings(0.2, 0.004, 0.7),
        L("embers", "embers", { count: P(70, m("mix.level", 0.12)), rise: 0.5, size: 0.9, brightness: 1.5 }, { opacity: 0.85 }),
      ]),
      S("main", "Main", [
        aurora(0.22, 1.0, 5),
        rings(0.25, 0.005, 0.9),
        L("embers", "embers", { count: P(200, m("mix.level", 0.15), m("drums.level", 0.1)), rise: P(0.8, m("bass.level", 0.3)), brightness: 1.7 }),
        L("ripples", "ripples", { trigger: "kick", every: 2, maxRadius: 0.7, rings: 2, width: 0.006, brightness: 1.3 }, { opacity: P(0.8, m("kick", 0.2, "exp")) }),
        L("sweep", "sweep", { trigger: "section", width: 0.16, brightness: 1.5 }),
      ]),
      S("full", "Full", [
        aurora(0.22, 1.15, 6),
        rings(0.3, 0.006, 1),
        L("embers", "embers", { count: P(300, m("mix.level", 0.12), m("drums.level", 0.08)), rise: P(1.0, m("bass.level", 0.3)), size: 1.05, brightness: 1.5 }),
        L("ripples", "ripples", { trigger: "kick", every: 1, maxRadius: 0.95, rings: 3, width: 0.006, brightness: 0.8 }, { opacity: P(0.6, m("kick", 0.12, "exp")) }),
        L("sweep", "sweep", { trigger: "section", width: 0.2, brightness: 1.2 }),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 0.8, flash: 0.15, brightness: 1.4 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.45, m("drop.pulse", 0.15), m("section.energy", 0.05)),
      vignette: 0.45,
      grain: 0.1,
      extra: [X("chroma", "chromatic", { amount: 3.5, source: "balance" })],
    }),
    controls: [
      { label: "Aurora glow", target: "aurora.brightness" },
      { label: "Aurora height", target: "aurora.height" },
      { label: "Wave rings", target: "waves.wobble" },
      { label: "Ring size", target: "waves.radius" },
      { label: "Embers", target: "embers.count" },
      { label: "Kick ripples", target: "ripples.maxRadius" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("karaoke", { size: 6.5, glow: 0.5, highlight: "mood", position: "lower" }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 2000 }, drop: { kind: "sweep", ms: 1400 }, chorusAfterLift: { kind: "sweep", ms: 1800 } } }),
  }),
};
