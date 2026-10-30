/** Tunnel Run (SPEC.md §6.10 #13): a ring per beat rushes past while the tunnel twists with the bass; drops tear the picture. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, X, director, globalPost, text } from "./kit";

const tunnel = (bright: number, rings: number, twist: number, speed: number, density: number) =>
  BG("tunnel", "tunnel", {
    brightness: P(bright, m("section.energy", 0.05), m("kick", 0.06, "exp")),
    ringsPerBeat: rings,
    twist: P(twist, m("bass.level", 0.35)),
    speed: P(speed, m("drums.level", 0.5), m("section.energy", 0.3)),
    density,
    segments: 12,
  });

export const tunnelRun: Preset = {
  id: "tunnel-run",
  name: "Tunnel Run",
  description: "A glowing tunnel where a new ring flies past on every beat, twisting with the bass and breaking up on the drop.",
  bestFor: "Techno, trance",
  show: makeShow({
    id: "tunnel-run",
    name: "Tunnel Run",
    palette: { mode: "fixed", ids: ["lava"] },
    scenes: [
      S("calm", "Calm", [tunnel(0.5, 0.5, 0.4, 0.5, 1.2)]),
      S("main", "Main", [tunnel(0.65, 1, 0.9, 0.9, 1.6)]),
      S("full", "Full", [
        tunnel(0.72, 2, 1.5, 1.4, 2),
        L("shock", "shockwave", { trigger: "drop+downbeat", strength: 0.8, flash: 0.2, brightness: 1.5 }),
        L("embers", "embers", { count: 120, rise: 1.2, size: 0.8, sparks: 0.6, brightness: 1.4 }, { opacity: 0.8 }),
      ]),
    ],
    post: globalPost({
      bloom: P(0.55, m("kick", 0.1, "exp"), m("drop.pulse", 0.2)),
      vignette: 0.45,
      grain: 0.1,
      extra: [X("zoom", "zoompulse", { amount: P(0.2, m("section.energy", 0.4)) }), X("glitch", "glitch", { amount: 0.6 })],
    }),
    controls: [
      { label: "Tunnel speed", target: "tunnel.speed" },
      { label: "Twist", target: "tunnel.twist" },
      { label: "Rings per beat", target: "tunnel.ringsPerBeat" },
      { label: "Ring density", target: "tunnel.density" },
      { label: "Beat zoom", target: "post.zoom.amount" },
      { label: "Drop glitch", target: "post.glitch.amount" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("pop", { size: 6.5, position: "lower", glow: 0.55 }),
    director: director({ transitions: { drop: { kind: "glitch", ms: 700 } } }),
  }),
};
