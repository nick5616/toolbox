/** Ink outline (FX2): Sobel edges on luma, `thickness` px apart; ink draws over, neon adds. */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_thick; uniform vec3 u_color; uniform float u_neon;
float L(vec2 off) { return sqrt(max(luma(texture(u_src, uv + off / u_res).rgb), 0.0)); }
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  float t = u_thick;
  float l0 = L(vec2(-t, -t)), l1 = L(vec2(0.0, -t)), l2 = L(vec2(t, -t));
  float l3 = L(vec2(-t, 0.0)), l5 = L(vec2(t, 0.0));
  float l6 = L(vec2(-t, t)), l7 = L(vec2(0.0, t)), l8 = L(vec2(t, t));
  float gx = -l0 - 2.0 * l3 - l6 + l2 + 2.0 * l5 + l8;
  float gy = -l0 - 2.0 * l1 - l2 + l6 + 2.0 * l7 + l8;
  float e = smoothstep(0.1, 0.5, length(vec2(gx, gy))) * u_amount;
  if (u_neon > 0.5) { o = vec4(c.rgb + u_color * e, max(c.a, e)); }
  else { o = vec4(mix(c.rgb, u_color * c.a, e), c.a); }
}`;

registerPost({
  type: "outline",
  label: "Ink outline",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    thickness: { kind: "number", label: "Thickness", min: 0.5, max: 4, default: 1 },
    color: { kind: "color", label: "Colour", default: "#000000" },
    mode: { kind: "enum", label: "Mode", options: ["ink", "neon"], default: "ink" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f1("u_thick", f.params.thickness as number)
        .f3("u_color", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_neon", f.params.mode === "neon" ? 1 : 0);
    });
  },
});
