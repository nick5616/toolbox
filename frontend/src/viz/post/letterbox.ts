/** Letterbox (FX2): bars top and bottom so the picture between is 2.39:1 at amount 1. */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { letterboxBar } from "./fx2math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_bar; uniform vec3 u_color;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_bar <= 0.0) { o = c; return; }
  float edge = min(uv.y, 1.0 - uv.y) * u_res.y;
  float cover = clamp(u_bar * u_res.y - edge + 0.5, 0.0, 1.0);
  o = mix(c, vec4(u_color, 1.0), cover);
}`;

registerPost({
  type: "letterbox",
  label: "Letterbox",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    color: { kind: "color", label: "Colour", default: "#000000" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      p.f1("u_bar", letterboxBar(w, h, f.params.amount as number)).f3(
        "u_color",
        paletteRef(f.palette, f.params.color as string, hexToLinear),
      );
    });
  },
});
