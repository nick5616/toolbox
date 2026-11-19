/**
 * Luma key (Phase 21 §B4): dark parts go transparent (bright ones with
 * `invert`). Math mirrored from `keymath.ts`. `amount` 0 is an exact identity.
 */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_threshold; uniform float u_softness; uniform float u_invert;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec3 s = c.a > 1e-5 ? c.rgb / c.a : vec3(0.0);
  float y = dot(pow(max(s, vec3(0.0)), vec3(1.0 / 2.2)), vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(u_threshold, u_threshold + max(u_softness, 1e-4), y);
  if (u_invert > 0.5) k = 1.0 - k;
  o = mix(c, c * k, clamp(u_amount, 0.0, 1.0));
}`;

registerPost({
  type: "lumakey",
  label: "Luma key",
  kind: "pass",
  params: {
    threshold: { kind: "number", label: "Threshold", min: 0, max: 1, default: 0.1 },
    softness: { kind: "number", label: "Softness", min: 0, max: 1, default: 0.1 },
    invert: { kind: "bool", label: "Key out the bright parts", default: false },
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 1 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f1("u_threshold", f.params.threshold as number)
        .f1("u_softness", f.params.softness as number)
        .f1("u_invert", f.params.invert === true ? 1 : 0);
    });
  },
});
