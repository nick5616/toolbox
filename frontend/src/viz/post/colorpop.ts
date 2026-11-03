/** Colour pop (FX2): desaturate everything outside a hue range. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_hue; uniform float u_range;
float hueOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  if (d <= 1e-9) return 0.0;
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return h * 60.0;
}
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec3 s = max(c.rgb / max(c.a, 1e-5), 0.0);
  float d = mod(abs(hueOf(s) - u_hue), 360.0);
  d = d > 180.0 ? 360.0 - d : d;
  float k = 1.0 - smoothstep(u_range, u_range * 1.5, d);
  vec3 res = mix(vec3(luma(c.rgb)), c.rgb, k);
  o = vec4(mix(c.rgb, res, u_amount), c.a);
}`;

registerPost({
  type: "colorpop",
  label: "Colour pop",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    hue: { kind: "number", label: "Hue", min: 0, max: 360, default: 0 },
    range: { kind: "number", label: "Range", min: 5, max: 180, default: 30 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amount", f.params.amount as number)
        .f1("u_hue", f.params.hue as number)
        .f1("u_range", f.params.range as number);
    });
  },
});
