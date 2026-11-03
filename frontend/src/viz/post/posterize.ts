/** Posterize (FX2): quantise straight colour to N levels per channel. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_levels;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec3 s = c.rgb / max(c.a, 1e-5);
  float n = u_levels - 1.0;
  vec3 q = floor(clamp(s, 0.0, 1.0) * n + 0.5) / n;
  o = vec4(mix(c.rgb, q * c.a, u_amount), c.a);
}`;

registerPost({
  type: "posterize",
  label: "Posterize",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    levels: { kind: "number", label: "Levels", min: 2, max: 16, default: 5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number).f1("u_levels", Math.max(2, Math.round(f.params.levels as number)));
    });
  },
});
