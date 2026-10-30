/** Camera shake (SPEC.md §6.7): the frame jitters on the kick, never more than 2% of the short side. */
import { shakeCover, shakeOffset } from "./px1math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform vec2 u_off; uniform float u_scale;
void main() { o = texture(u_src, (uv - 0.5) / u_scale + 0.5 + u_off / u_res); }`;

registerPost({
  type: "shake",
  label: "Camera shake",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      const kick = f.signals.value("kick", f.tMs, 5, 120);
      const [ox, oy] = shakeOffset(f.tMs, f.seed, kick, Math.min(w, h), f.params.amount as number);
      p.f2("u_off", ox, oy).f1("u_scale", shakeCover(ox, oy, w, h));
    });
  },
});
