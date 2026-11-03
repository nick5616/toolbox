/** Invert (ES5): premultiplied colour inversion, mixed in by the amount. */
import { simplePass } from "./pass";
import { clamp01 } from "./px1math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount;
void main() { vec4 c = texture(u_src, uv); o = vec4(mix(c.rgb, c.a - c.rgb, u_amount), c.a); }`;

registerPost({
  type: "invert",
  label: "Invert",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", clamp01(f.params.amount as number));
    });
  },
});
