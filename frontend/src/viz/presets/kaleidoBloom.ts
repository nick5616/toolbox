/** Kaleido Bloom (SPEC.md §6.10 #9): a nebula fed through a kaleidoscope that turns with the bars; a mirror post joins on big sections. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const neb = (bright: number, warp: number) =>
  BG("neb", "nebula", { brightness: P(bright, m("section.energy", 0.05)), warp: P(warp, m("bass.level", 0.2)), sparkle: P(0.4, m("hats", 0.4, "exp")), speed: 0.8, detail: 5 });

const feed = (r: number) =>
  L("feed", "wavering", { pair: false, rings: 2, radius: P(r, m("kick", 0.05, "exp"), m("section.energy", 0.05)), wobble: P(0.5, m("bass.level", 0.3)), thickness: 0.008, glow: 0.6, brightness: 1.3, color: "cycle" }, { opacity: 0.85 });

const kaleido = (segments: number, spin: number, zoom: number, brightness: number) =>
  L("kal", "kaleido", {
    segments,
    spin: P(spin, m("bar.pulse", 0.15), m("drums.level", 0.2)),
    zoom: P(zoom, m("kick", 0.25, "exp")),
    swirl: P(0.25, m("other.level", 0.3)),
    trail: 0.72,
    brightness,
  }, { blend: "normal" });

export const kaleidoBloom: Preset = {
  id: "kaleido-bloom",
  name: "Kaleido Bloom",
  description: "A glowing nebula folded into a turning kaleidoscope that blooms on the kick and spins with every bar.",
  bestFor: "Psychedelic, electronic",
  show: makeShow({
    id: "kaleido-bloom",
    name: "Kaleido Bloom",
    palette: { mode: "fixed", ids: ["plasma"] },
    scenes: [
      S("calm", "Calm", [neb(0.4, 0.5), feed(0.12), kaleido(6, 0.2, 0.1, 0.6)]),
      S("main", "Main", [neb(0.45, 0.7), feed(0.18), kaleido(8, 0.5, 0.3, 0.8)]),
      S(
        "full",
        "Full",
        [neb(0.5, 0.9), feed(0.22), kaleido(12, 0.9, 0.5, 0.85), L("ripples", "ripples", { trigger: "kick", every: 2, maxRadius: 0.9, rings: 2, width: 0.005, brightness: 1.1, color: "accent" }, { opacity: 0.7 })],
        [X("mir", "mirror", { segments: 6, spin: 0.1, zoom: 1, mix: 0.45 })],
      ),
    ],
    post: globalPost({ bloom: P(0.65, m("kick", 0.1, "exp"), m("drop.pulse", 0.2)), vignette: 0.4, grain: 0.1 }),
    controls: [
      { label: "Segments", target: "kal.segments" },
      { label: "Spin", target: "kal.spin" },
      { label: "Kick zoom", target: "kal.zoom" },
      { label: "Swirl", target: "kal.swirl" },
      { label: "Cloud swirl", target: "neb.warp" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("wave", { size: 6.5, position: "lower", glow: 0.7 }),
    director: director(),
  }),
};
