/** Shockwave (FX1): an expanding refracting ring. Mirrors fx1math.shockDisp. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_width; uniform float u_str; uniform vec2 u_c;
void main() {
  if (u_amt <= 0.0 || u_str <= 0.0) { o = texture(u_src, uv); return; }
  float s = min(u_res.x, u_res.y);
  float halfDiag = 0.5 * length(u_res / s);
  vec2 p = (uv - u_c) * u_res / s;
  float r = length(p);
  float w = u_width * halfDiag;
  float d = r - (1.0 - u_amt) * 1.2 * halfDiag;
  if (abs(d) >= w || r < 1e-6) { o = texture(u_src, uv); return; }
  float ring = (1.0 + cos(3.14159265 * d / w)) * 0.5;
  float disp = 0.5 * u_amt * u_str * w * ring;
  vec2 q = p - p / r * disp;
  o = texture(u_src, u_c + q * s / u_res);
}`;

registerPost({
  type: "shockwave",
  label: "Shockwave",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    width: { kind: "number", label: "Width", min: 0.01, max: 0.3, default: 0.08 },
    strength: { kind: "number", label: "Strength", min: 0, max: 1, default: 0.5 },
    cx: { kind: "number", label: "Centre X", min: 0, max: 1, default: 0.5 },
    cy: { kind: "number", label: "Centre Y", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number)
        .f1("u_width", f.params.width as number)
        .f1("u_str", f.params.strength as number)
        .f2("u_c", f.params.cx as number, f.params.cy as number);
    });
  },
});
