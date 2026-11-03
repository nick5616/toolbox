/** Motion blur (FX1): directional blur, 24 taps. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_ang;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  float len = u_amt * 0.12 * min(u_res.x, u_res.y);
  vec2 dir = vec2(cos(u_ang), sin(u_ang)) * len / u_res;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    acc += texture(u_src, uv + dir * (float(i) / 23.0 - 0.5));
  }
  o = acc / 24.0;
}`;

registerPost({
  type: "dirblur",
  label: "Motion blur",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    angle: { kind: "number", label: "Angle", min: -180, max: 180, default: 0 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number).f1("u_ang", ((f.params.angle as number) * Math.PI) / 180);
    });
  },
});
