/** Slice shift (FX1): horizontal bands shifted by hashed amounts that change every 66 ms, plus an RGB split. Mirrors fx1math.sliceShift. */
import { SLICE_STEP_MS } from "./fx1math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_bands; uniform float u_rgb; uniform float u_bucket; uniform float u_seed;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  float band = floor(uv.y * u_bands);
  float h = hash21(vec2(band + u_seed * 7.31, u_bucket));
  float h2 = hash21(vec2(band + 91.7, u_bucket + u_seed));
  float shift = (h - 0.5) * 2.0 * u_amt * 0.25;
  float split = (h2 - 0.5) * 2.0 * u_rgb * u_amt * 0.04;
  vec2 c = vec2(uv.x + shift, uv.y);
  vec4 g = texture(u_src, c);
  vec4 r = texture(u_src, c + vec2(split, 0.0));
  vec4 b = texture(u_src, c - vec2(split, 0.0));
  o = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`;

registerPost({
  type: "slice",
  label: "Slice shift",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    bands: { kind: "number", label: "Bands", min: 2, max: 64, default: 12, step: 1 },
    rgb: { kind: "number", label: "RGB split", min: 0, max: 1, default: 0.3 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number)
        .f1("u_bands", Math.max(2, Math.round(f.params.bands as number)))
        .f1("u_rgb", f.params.rgb as number)
        .f1("u_bucket", Math.floor(f.tMs / SLICE_STEP_MS))
        .f1("u_seed", f.seed % 1000);
    });
  },
});
