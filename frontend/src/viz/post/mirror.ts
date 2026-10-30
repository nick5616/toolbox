/** Mirror / kaleidoscope post (SPEC.md §6.7): folds the frame into N mirrored wedges around the centre. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_seg; uniform float u_rot; uniform float u_zoom; uniform float u_amt;
void main() {
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - 0.5) * u_res / s;
  float r = length(p);
  float a = atan(p.y, p.x) + u_rot;
  float seg = 6.2831853 / u_seg;
  a = mod(a, seg * 2.0);
  a = a > seg ? seg * 2.0 - a : a;
  vec2 q = vec2(cos(a), sin(a)) * r / u_zoom;
  vec2 suv = q * s / u_res + 0.5;
  suv = 1.0 - abs(1.0 - abs(suv));
  o = mix(texture(u_src, uv), texture(u_src, suv), u_amt);
}`;

registerPost({
  type: "mirror",
  label: "Mirror / kaleidoscope",
  kind: "pass",
  params: {
    segments: { kind: "number", label: "Segments", min: 2, max: 16, default: 6, step: 1 },
    spin: { kind: "number", label: "Spin", min: -1, max: 1, default: 0.15 },
    zoom: { kind: "number", label: "Zoom", min: 0.5, max: 2, default: 1 },
    mix: { kind: "number", label: "Amount", min: 0, max: 1, default: 1 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_seg", Math.round(f.params.segments as number))
        .f1("u_rot", (f.params.spin as number) * f.motionSec * 0.6)
        .f1("u_zoom", f.params.zoom as number)
        .f1("u_amt", f.params.mix as number);
    });
  },
});
