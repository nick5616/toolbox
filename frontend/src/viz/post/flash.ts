/** Flash (ES5): a colour flash added or screened over the frame; alpha rises to the amount. */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { clamp01 } from "./px1math";
import { flashGain } from "./px2math";
import { registerPost } from "./registry";

const SRC = `
uniform vec3 u_color; uniform float u_gain; uniform float u_amount; uniform float u_screen;
void main() {
  vec4 c = texture(u_src, uv);
  vec3 add = u_color * u_gain;
  vec3 s = min(add, vec3(1.0));
  vec3 rgb = mix(c.rgb + add, c.rgb + s - c.rgb * s, u_screen);
  o = vec4(rgb, max(c.a, u_amount));
}`;

registerPost({
  type: "flash",
  label: "Flash",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    color: { kind: "color", label: "Colour", default: "#ffffff" },
    mode: { kind: "enum", label: "Mode", options: ["add", "screen"], default: "add" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      const amount = f.params.amount as number;
      p.f3("u_color", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_gain", flashGain(amount))
        .f1("u_amount", clamp01(amount))
        .f1("u_screen", f.params.mode === "screen" ? 1 : 0);
    });
  },
});
