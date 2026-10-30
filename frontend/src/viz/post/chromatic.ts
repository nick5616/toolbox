/** Chromatic aberration (SPEC.md §6.7): RGB split that grows toward the edges, driven by kick, snare or the left/right balance. */
import { chromaticPx } from "./px1math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_radial; uniform float u_shift;
void main() {
  vec2 p = (uv - 0.5) * u_res;
  float len = length(p);
  vec2 dir = len > 0.0 ? p / len : vec2(0.0);
  float edge = len / (0.5 * length(u_res));
  vec2 off = (dir * edge * u_radial + vec2(u_shift, 0.0)) / u_res;
  vec4 g = texture(u_src, uv);
  float r = texture(u_src, uv + off).r;
  float b = texture(u_src, uv - off).b;
  o = vec4(r, g.g, b, g.a);
}`;

registerPost({
  type: "chromatic",
  label: "Chromatic aberration",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount (px)", min: 0, max: 24, default: 4 },
    source: { kind: "enum", label: "Driven by", options: ["kick", "snare", "balance", "none"], default: "kick" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      const amount = f.params.amount as number;
      const src = f.params.source as string;
      const short = Math.min(w, h);
      let radial: number;
      let shift = 0;
      if (src === "balance") {
        const bal = (f.signals.value("mix.balance", f.tMs, 30, 200) - 0.5) * 2;
        radial = chromaticPx(amount, 0.2, short);
        shift = chromaticPx(amount, Math.abs(bal), short) * Math.sign(bal) * 0.5;
      } else if (src === "none") {
        radial = chromaticPx(amount, 1, short) * 0.5;
      } else {
        radial = chromaticPx(amount, f.signals.value(src === "snare" ? "snare" : "kick", f.tMs, 5, 140), short);
      }
      p.f1("u_radial", radial).f1("u_shift", shift);
    });
  },
});
