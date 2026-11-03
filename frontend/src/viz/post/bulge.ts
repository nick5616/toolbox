/** Bulge / pinch (FX1). Mirrors fx1math.bulgeMap. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_rad; uniform vec2 u_c;
void main() {
  if (u_amt == 0.0 || u_rad <= 0.0) { o = texture(u_src, uv); return; }
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - u_c) * u_res / s;
  float rn = length(p) / u_rad;
  if (rn >= 1.0) { o = texture(u_src, uv); return; }
  float f = 1.0 - 0.8 * u_amt * (1.0 - rn * rn);
  o = texture(u_src, u_c + p * f * s / u_res);
}`;

registerPost({
  type: "bulge",
  label: "Bulge / pinch",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: -1, max: 1, default: 0 },
    radius: { kind: "number", label: "Radius", min: 0, max: 1, default: 0.5 },
    cx: { kind: "number", label: "Centre X", min: 0, max: 1, default: 0.5 },
    cy: { kind: "number", label: "Centre Y", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number)
        .f1("u_rad", f.params.radius as number)
        .f2("u_c", f.params.cx as number, f.params.cy as number);
    });
  },
});
