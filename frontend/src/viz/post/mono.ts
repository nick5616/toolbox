/** Black and white (FX2): contrast about mid grey (display space); `hard` thresholds at 50 %. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_contrast; uniform float u_hard;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec3 s = c.rgb / max(c.a, 1e-5);
  float sd = pow(max(luma(s), 0.0), 1.0 / 2.2);
  sd = (sd - 0.5) * u_contrast + 0.5;
  if (u_hard > 0.5) sd = sd >= 0.5 ? 1.0 : 0.0;
  float g = pow(clamp(sd, 0.0, 1.0), 2.2);
  o = vec4(mix(c.rgb, vec3(g) * c.a, u_amount), c.a);
}`;

registerPost({
  type: "mono",
  label: "Black and white",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 3, default: 1 },
    hard: { kind: "bool", label: "Hard threshold", default: false },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f1("u_contrast", f.params.contrast as number)
        .f1("u_hard", f.params.hard === true ? 1 : 0);
    });
  },
});
