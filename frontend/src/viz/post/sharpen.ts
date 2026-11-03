/** Sharpen (FX2): unsharp mask against the 4-neighbour mean. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec2 px = 1.0 / u_res;
  vec4 m = 0.25 * (texture(u_src, uv + vec2(px.x, 0.0)) + texture(u_src, uv - vec2(px.x, 0.0)) + texture(u_src, uv + vec2(0.0, px.y)) + texture(u_src, uv - vec2(0.0, px.y)));
  o = vec4(max(c.rgb + u_amount * (c.rgb - m.rgb), 0.0), c.a);
}`;

registerPost({
  type: "sharpen",
  label: "Sharpen",
  kind: "pass",
  params: { amount: { kind: "number", label: "Amount", min: 0, max: 2, default: 0 } },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number);
    });
  },
});
