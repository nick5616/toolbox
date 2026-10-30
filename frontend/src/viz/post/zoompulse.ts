/** Zoom pulse (SPEC.md §6.7): the frame breathes in on every beat. */
import { zoomPulseScale } from "./px1math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_scale;
void main() { o = texture(u_src, (uv - 0.5) / u_scale + 0.5); }`;

registerPost({
  type: "zoompulse",
  label: "Zoom pulse",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.35 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_scale", zoomPulseScale(f.signals.value("beat.pulse", f.tMs), f.params.amount as number));
    });
  },
});
