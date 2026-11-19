/** Tunnel Run (SPEC.md §6.10 #13): a ring per beat rushes past while the tunnel twists slowly with the bass; only drops tear the picture. Retuned to the motion grammar (Phase 21). */
import type { Preset } from "./types";
import { BG, L, duck, groove, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const tunnel = (bright: number, rings: number, twist: number, speed: number, density: number) =>
  BG("tunnel", "tunnel", {
    // the layer's own shader already flashes a touch on the kick and speeds up with the drums
    brightness: P(bright, m("section.energy", 0.05)),
    ringsPerBeat: rings,
    twist: P(twist, groove("bass.level", 0.08)),
    speed: P(speed, m("section.energy", 0.1, "linear", 600, 1500)),
    density,
    segments: 12,
  });

export const tunnelRun: Preset = {
  id: "tunnel-run",
  name: "Tunnel Run",
  description: "A glowing tunnel where a new ring flies past on every beat, twisting slowly with the bass and breaking up only on the drop.",
  bestFor: "Techno, trance",
  show: makeShow({
    id: "tunnel-run",
    name: "Tunnel Run",
    palette: { mode: "fixed", ids: ["lava"] },
    scenes: [
      S("calm", "Calm", [tunnel(0.45, 0.5, 0.4, 0.45, 1.2)]),
      S("main", "Main", [tunnel(0.55, 0.75, 0.8, 0.7, 1.5)]),
      S("full", "Full", [
        tunnel(0.6, 0.75, 1.1, 0.95, 1.8),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 0.8, flash: 0.2, brightness: 1.5 }),
        L("embers", "embers", { count: 120, rise: 1, size: 0.8, sparks: 0.6, brightness: 1.4 }, { opacity: P(0.8, duck()) }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.55, groove("bass.level", 0.06), m("drop.pulse", 0.15)),
      vignette: 0.45,
      grain: 0.1,
      extra: [X("zoom", "zoompulse", { amount: P(0.2, m("section.energy", 0.3)) }), X("glitch", "glitch", { amount: 0.5 })],
    }),
    controls: [
      { label: "Tunnel speed", target: "tunnel.speed" },
      { label: "Twist", target: "tunnel.twist" },
      { label: "Rings per beat", target: "tunnel.ringsPerBeat" },
      { label: "Ring density", target: "tunnel.density" },
      { label: "Bar zoom", target: "post.zoom.amount" },
      { label: "Drop glitch", target: "post.glitch.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.55 }),
    director: director({ transitions: { drop: { kind: "glitch", ms: 700 } } }),
  }),
};
