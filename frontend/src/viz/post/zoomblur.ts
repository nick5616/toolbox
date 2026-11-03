/** Zoom blur (FX1): radial blur towards a centre, 24 taps. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform vec2 u_c;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float s = 1.0 - u_amt * 0.35 * (float(i) / 23.0);
    acc += texture(u_src, u_c + (uv - u_c) * s);
  }
  o = acc / 24.0;
}`;

registerPost({
  type: "zoomblur",
  label: "Zoom blur",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    cx: { kind: "number", label: "Centre X", min: 0, max: 1, default: 0.5 },
    cy: { kind: "number", label: "Centre Y", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number).f2("u_c", f.params.cx as number, f.params.cy as number);
    });
  },
});
