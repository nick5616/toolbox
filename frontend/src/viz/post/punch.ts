/** Zoom punch (ES5): a quick push-in with optional rotation and a radial blur toward the centre. */
import { punchTransform } from "./px2math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_scale; uniform float u_angle; uniform float u_blur;
void main() {
  vec2 p = (uv - 0.5) * u_res;
  float reach = u_blur / max(0.5 * length(u_res), 1.0);
  float ca = cos(u_angle), sa = sin(u_angle);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 q = p * (1.0 - reach * float(i) / 7.0);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y) / u_scale;
    acc += texture(u_src, q / u_res + 0.5);
  }
  o = acc / 8.0;
}`;

registerPost({
  type: "punch",
  label: "Zoom punch",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    zoom: { kind: "number", label: "Zoom", min: 0, max: 0.6, default: 0.15 },
    rotate: { kind: "number", label: "Rotate (deg)", min: -15, max: 15, default: 0 },
    blur: { kind: "number", label: "Blur", min: 0, max: 1, default: 0.3 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      const t = punchTransform(f.params.amount as number, f.params.zoom as number, f.params.rotate as number, f.params.blur as number, w, h);
      p.f1("u_scale", t.scale).f1("u_angle", t.angle).f1("u_blur", t.blurPx);
    });
  },
});
