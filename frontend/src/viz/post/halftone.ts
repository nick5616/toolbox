/** Halftone (FX2): rotated dot screen; dot area follows the cell's brightness. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform float u_cell; uniform float u_angle; uniform float u_color;
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0) { o = c; return; }
  vec2 px = uv * u_res;
  float ca = cos(u_angle), sa = sin(u_angle);
  vec2 p = vec2(ca * px.x + sa * px.y, -sa * px.x + ca * px.y);
  vec2 g = (floor(p / u_cell) + 0.5) * u_cell;
  float d = length(p - g);
  vec2 centre = vec2(ca * g.x - sa * g.y, sa * g.x + ca * g.y);
  vec4 s = texture(u_src, clamp(centre, vec2(0.5), u_res - 0.5) / u_res);
  vec3 straight = max(s.rgb / max(s.a, 1e-5), 0.0);
  float l = clamp(luma(pow(straight, vec3(1.0 / 2.2))), 0.0, 1.0);
  float r = 0.7072 * u_cell * sqrt(l);
  float cov = clamp(0.5 - (d - r), 0.0, 1.0) * smoothstep(0.0, 0.5, r);
  vec3 dotc = u_color > 0.5 ? min(straight, vec3(1.0)) * cov : vec3(cov);
  o = vec4(mix(c.rgb, dotc * s.a, u_amount), c.a);
}`;

registerPost({
  type: "halftone",
  label: "Halftone",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    dots: { kind: "number", label: "Dots across", min: 20, max: 240, default: 90 },
    angle: { kind: "number", label: "Angle", min: -90, max: 90, default: 45 },
    mode: { kind: "enum", label: "Mode", options: ["mono", "color"], default: "mono" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      const dots = Math.max(1, f.params.dots as number);
      p.f1("u_amount", f.params.amount as number)
        .f1("u_cell", Math.min(w, h) / dots)
        .f1("u_angle", ((f.params.angle as number) * Math.PI) / 180)
        .f1("u_color", f.params.mode === "color" ? 1 : 0);
    });
  },
});
