/** Pixelate (FX2): blocks of 1 + amount·0.08·short side pixels; amount 0 is a 1 px block (identity). */
import { simplePass } from "./pass";
import { pixelBlock } from "./fx2math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_block;
void main() {
  if (u_block <= 1.0) { o = texture(u_src, uv); return; }
  vec2 px = uv * u_res;
  vec2 c = (floor(px / u_block) + 0.5) * u_block;
  o = texture(u_src, min(c, u_res - 0.5) / u_res);
}`;

registerPost({
  type: "pixelate",
  label: "Pixelate",
  kind: "pass",
  params: { amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 } },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      p.f1("u_block", pixelBlock(f.params.amount as number, Math.min(w, h)));
    });
  },
});
