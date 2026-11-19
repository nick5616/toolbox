/** Zoom pulse (SPEC.md §6.7): the frame breathes in on every bar (3% at most). */
import { zoomPulseScale } from "./px1math";
import { triggerDrive } from "./px2math";
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
    trigger: { kind: "enum", label: "Triggered by", options: ["bar", "beat", "amount"], default: "bar" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      const drive = triggerDrive(f.params.trigger, () => (f.params.trigger === "beat" ? f.signals.value("beat.pulse", f.tMs) : f.signals.value("bar.pulse", f.tMs)));
      p.f1("u_scale", zoomPulseScale(drive * f.intensity, f.params.amount as number));
    });
  },
});
