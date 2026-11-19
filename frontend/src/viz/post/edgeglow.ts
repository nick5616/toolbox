/**
 * Edge glow (Color Grader): Sobel edges of the picture's brightness drawn as a neon line, with a soft second
 * ring. Added over the picture; an exact identity at amount 0. Gate it to a region with gradelook's stash/restore.
 */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform vec3 u_col; uniform float u_px; uniform float u_gain;
float L(vec2 p) { vec4 c = texture(u_src, p); return pow(max(luma(c.rgb / max(c.a, 1e-5)), 0.0), 1.0 / 2.2); }
float sobel(float r) {
  vec2 t = r / u_res;
  float a = L(uv + t * vec2(-1.0, -1.0)); float b = L(uv + t * vec2(0.0, -1.0)); float c = L(uv + t * vec2(1.0, -1.0));
  float d = L(uv + t * vec2(-1.0, 0.0)); float f = L(uv + t * vec2(1.0, 0.0));
  float g = L(uv + t * vec2(-1.0, 1.0)); float h = L(uv + t * vec2(0.0, 1.0)); float i = L(uv + t * vec2(1.0, 1.0));
  return length(vec2((c + 2.0 * f + i) - (a + 2.0 * d + g), (g + 2.0 * h + i) - (a + 2.0 * b + c)));
}
void main() {
  vec4 s = texture(u_src, uv);
  if (u_amount <= 0.0) { o = s; return; }
  float e = sobel(u_px) + 0.6 * sobel(u_px * 2.5);
  e = smoothstep(0.05, 0.9, e);
  vec3 add = u_col * min(e * u_gain, 2.0) * u_amount;
  o = vec4(s.rgb + add, max(s.a, min(1.0, luma(add))));
}`;

registerPost({
  type: "edgeglow",
  label: "Edge glow",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    color: { kind: "color", label: "Colour", default: "#ff2bd6" },
    thickness: { kind: "number", label: "Thickness", min: 0.5, max: 4, default: 1.5 },
    strength: { kind: "number", label: "Strength", min: 0, max: 3, default: 1 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, _w, h) => {
      p.f1("u_amount", f.params.amount as number)
        .f3("u_col", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_px", (f.params.thickness as number) * Math.max(0.5, h / 1080))
        .f1("u_gain", f.params.strength as number);
    });
  },
});
