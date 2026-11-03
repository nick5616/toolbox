/** Kaleidoscope (FX1): folds the frame into mirrored wedges, mixed in by amount. Mirrors fx1math.kaleidoAngle. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_seg; uniform float u_rot; uniform float u_zoom;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - 0.5) * u_res / s;
  float r = length(p);
  float seg = 6.2831853 / u_seg;
  float a = mod(atan(p.y, p.x) - u_rot, seg * 2.0);
  a = a > seg ? seg * 2.0 - a : a;
  vec2 q = vec2(cos(a), sin(a)) * r / u_zoom;
  vec2 suv = q * s / u_res + 0.5;
  suv = 1.0 - abs(1.0 - mod(suv, 2.0));
  o = mix(texture(u_src, uv), texture(u_src, suv), u_amt);
}`;

registerPost({
  type: "kaleido",
  label: "Kaleidoscope",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    segments: { kind: "number", label: "Segments", min: 2, max: 16, default: 6, step: 1 },
    rotation: { kind: "number", label: "Rotation", min: -180, max: 180, default: 0 },
    zoom: { kind: "number", label: "Zoom", min: 0.5, max: 2, default: 1 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_amt", f.params.amount as number)
        .f1("u_seg", Math.max(2, Math.round(f.params.segments as number)))
        .f1("u_rot", ((f.params.rotation as number) * Math.PI) / 180)
        .f1("u_zoom", f.params.zoom as number);
    });
  },
});
