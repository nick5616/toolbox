/** Twirl (FX1): rotates the picture around a centre, strongest in the middle. Mirrors fx1math.twirlMap. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_rad; uniform vec2 u_c;
void main() {
  if (u_amt == 0.0) { o = texture(u_src, uv); return; }
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - u_c) * u_res / s;
  float r = length(p);
  if (u_rad <= 0.0 || r >= u_rad) { o = texture(u_src, uv); return; }
  float k = 1.0 - r / u_rad;
  float a = u_amt * 6.2831853 * k * k;
  float c = cos(a), sn = sin(a);
  vec2 q = vec2(c * p.x - sn * p.y, sn * p.x + c * p.y);
  o = texture(u_src, u_c + q * s / u_res);
}`;

registerPost({
  type: "twirl",
  label: "Twirl",
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
