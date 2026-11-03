/** Duotone (FX2): a luma gradient map from shadows to highlights. */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform vec3 u_sh; uniform vec3 u_hi;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec3 s = c.rgb / max(c.a, 1e-5);
  float l = clamp(luma(s), 0.0, 1.0);
  vec3 g = mix(u_sh, u_hi, l) * c.a;
  o = vec4(mix(c.rgb, g, u_amount), c.a);
}`;

registerPost({
  type: "duotone",
  label: "Duotone",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    shadows: { kind: "color", label: "Shadows", default: "#1b0436" },
    highlights: { kind: "color", label: "Highlights", default: "#ff4fd8" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f3("u_sh", paletteRef(f.palette, f.params.shadows as string, hexToLinear))
        .f3("u_hi", paletteRef(f.palette, f.params.highlights as string, hexToLinear));
    });
  },
});
