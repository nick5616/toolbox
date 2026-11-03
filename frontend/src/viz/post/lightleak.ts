/** Light leak (FX2): soft procedural blobs drifting with tMs, screen-blended. */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform vec3 u_color; uniform float u_time; uniform float u_seed; uniform float u_aspect;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float ph = hash11(u_seed * 7.0 + fi * 13.0) * 6.2831853;
    vec2 ctr = vec2(0.5 + 0.55 * sin(u_time * (0.31 + 0.11 * fi) + ph), 0.5 + 0.55 * cos(u_time * (0.23 + 0.09 * fi) + ph * 1.7));
    float r = 0.28 + 0.1 * fi;
    vec2 d = (uv - ctr) * vec2(u_aspect, 1.0);
    s += exp(-dot(d, d) / (r * r));
  }
  float k = clamp(s * 0.6, 0.0, 1.0) * u_amount;
  vec3 leak = min(u_color * k, vec3(1.0));
  o = vec4(c.rgb + leak - c.rgb * leak, c.a + (1.0 - c.a) * k);
}`;

registerPost({
  type: "lightleak",
  label: "Light leak",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    color: { kind: "color", label: "Colour", default: "#ff8a3d" },
    speed: { kind: "number", label: "Speed", min: 0, max: 2, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      p.f1("u_amount", f.params.amount as number)
        .f3("u_color", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_time", (f.tMs / 1000) * (f.params.speed as number))
        .f1("u_seed", f.seed % 1024)
        .f1("u_aspect", w / h);
    });
  },
});
