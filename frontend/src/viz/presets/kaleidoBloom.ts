/** Kaleido Bloom (SPEC.md §6.10 #9): a nebula fed through a kaleidoscope that turns with the bars; a mirror post joins on big sections. */
import type { Preset } from "./types";
import { BG, L, drift, duck, groove, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const neb = (bright: number, warp: number) =>
  BG("neb", "nebula", { brightness: P(bright, m("section.energy", 0.05)), warp: P(warp, groove("bass.level", 0.08)), sparkle: 0.4, speed: 0.8, detail: 5 });

const feed = (r: number) =>
  L("feed", "wavering", { pair: false, rings: 2, radius: P(r, groove("bass.level", 0.03), m("section.energy", 0.05)), wobble: P(0.5, groove("bass.level", 0.12)), thickness: 0.008, glow: 0.6, brightness: 1.3, color: "cycle" }, { opacity: 0.85 });

const kaleido = (segments: number, spin: number, zoom: number, brightness: number) =>
  L("kal", "kaleido", {
    segments,
    // the kaleidoscope's own shader already blooms on the kick; the spin only leans a little into each bar
    spin: P(spin, m("bar.pulse", 0.08, "ease", 200, 1200)),
    zoom,
    swirl: P(0.25, drift(0.15)),
    trail: 0.72,
    brightness,
  }, { blend: "normal" });

export const kaleidoBloom: Preset = {
  id: "kaleido-bloom",
  name: "Kaleido Bloom",
  description: "A glowing nebula folded into a slowly turning kaleidoscope that blooms with the kick and leans into every bar.",
  bestFor: "Psychedelic, electronic",
  show: makeShow({
    id: "kaleido-bloom",
    name: "Kaleido Bloom",
    palette: { mode: "fixed", ids: ["plasma"] },
    scenes: [
      S("calm", "Calm", [neb(0.4, 0.5), feed(0.12), kaleido(6, 0.2, 0.1, 0.6)]),
      S("main", "Main", [neb(0.45, 0.7), feed(0.18), kaleido(8, 0.4, 0.25, 0.8)]),
      S(
        "full",
        "Full",
        [neb(0.5, 0.9), feed(0.22), kaleido(12, 0.7, 0.4, 0.85), L("ripples", "ripples", { trigger: "kick", every: 2, maxRadius: 0.9, rings: 2, width: 0.005, brightness: 1.1, color: "accent" }, { opacity: P(0.7, duck()) })],
        [X("mir", "mirror", { segments: 6, spin: 0.1, zoom: 1, mix: 0.45 })],
      ),
    ],
    post: globalPost({ bloom: P(0.65, groove("bass.level", 0.06), m("drop.pulse", 0.15)), vignette: 0.4, grain: 0.1 }),
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
