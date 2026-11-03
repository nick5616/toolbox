/** Speed lines (FX2): anime radial lines that change every 2 frames (bucket floor(tMs/66)). */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { speedBucket } from "./fx2math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_density; uniform float u_inner; uniform vec3 u_color;
uniform vec2 u_centre; uniform float u_bucket; uniform float u_seed;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec2 d = (uv - u_centre) * u_res;
  float rmax = length(max(u_centre, 1.0 - u_centre) * u_res);
  float rn = length(d) / max(rmax, 1.0);
  float a = fract(atan(d.y, d.x) / 6.2831853 + 1.0);
  float idx = floor(a * u_density);
  float h = hash21(vec2(idx, u_bucket * 1.7 + u_seed));
  float lit = step(0.45, h);
  float width = 0.3 + 0.7 * hash21(vec2(idx + 91.0, u_bucket + u_seed * 2.3));
  float f = a * u_density - idx;
  float ray = 1.0 - smoothstep(width * 0.5 - 0.1, width * 0.5 + 0.1, abs(f - 0.5));
  float m = lit * ray * smoothstep(u_inner, u_inner + 0.25, rn) * u_amount;
  o = mix(c, vec4(u_color, 1.0), m);
}`;

registerPost({
  type: "speedlines",
  label: "Speed lines",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    density: { kind: "number", label: "Density", min: 20, max: 240, default: 90 },
    inner: { kind: "number", label: "Clear radius", min: 0, max: 0.9, default: 0.35 },
    color: { kind: "color", label: "Colour", default: "#ffffff" },
    cx: { kind: "number", label: "Centre X", min: 0, max: 1, default: 0.5 },
    cy: { kind: "number", label: "Centre Y", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f1("u_density", Math.round(f.params.density as number))
        .f1("u_inner", f.params.inner as number)
        .f3("u_color", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f2("u_centre", f.params.cx as number, f.params.cy as number)
        .f1("u_bucket", speedBucket(f.tMs))
        .f1("u_seed", f.seed % 1024);
    });
  },
});
