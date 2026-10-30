/** Colour grade (SPEC.md §6.7): lift / gamma / gain, saturation and warmth. Every value is reactive, so mood can drive it. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_lift; uniform float u_gamma; uniform float u_gain; uniform float u_sat; uniform float u_warm;
void main() {
  vec4 c = texture(u_src, uv);
  vec3 rgb = max(c.rgb * u_gain + u_lift * c.a, 0.0);
  rgb = pow(rgb, vec3(1.0 / max(u_gamma, 0.05)));
  float l = luma(rgb);
  rgb = mix(vec3(l), rgb, u_sat);
  rgb *= vec3(1.0 + u_warm * 0.12, 1.0, 1.0 - u_warm * 0.12);
  o = vec4(max(rgb, 0.0), c.a);
}`;

registerPost({
  type: "grade",
  label: "Colour grade",
  kind: "pass",
  params: {
    lift: { kind: "number", label: "Lift (shadows)", min: -0.1, max: 0.1, default: 0 },
    gamma: { kind: "number", label: "Gamma (mids)", min: 0.5, max: 1.8, default: 1 },
    gain: { kind: "number", label: "Gain (highlights)", min: 0.5, max: 1.8, default: 1 },
    saturation: { kind: "number", label: "Saturation", min: 0, max: 2, default: 1.1 },
    warmth: { kind: "number", label: "Warmth", min: -1, max: 1, default: 0 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      p.f1("u_lift", f.params.lift as number)
        .f1("u_gamma", f.params.gamma as number)
        .f1("u_gain", f.params.gain as number)
        .f1("u_sat", f.params.saturation as number)
        .f1("u_warm", f.params.warmth as number);
    });
  },
});
