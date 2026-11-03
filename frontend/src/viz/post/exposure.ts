/** Exposure pulse (ES5): brightens or darkens the frame by up to `stops` stops. */
import { simplePass } from "./pass";
import { exposureGain } from "./px2math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_gain;
void main() { vec4 c = texture(u_src, uv); o = vec4(c.rgb * u_gain, c.a); }`;

registerPost({
  type: "exposure",
  label: "Exposure pulse",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: -1, max: 1, default: 0 },
    stops: { kind: "number", label: "Stops", min: 0, max: 3, default: 1.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_gain", exposureGain(f.params.amount as number, f.params.stops as number));
    });
  },
});
