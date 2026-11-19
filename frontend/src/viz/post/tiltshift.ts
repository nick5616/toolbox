/**
 * Depth blur / tilt-shift (Color Grader): keeps one distance sharp and blurs the rest with a disc blur whose
 * radius grows with the distance from the focus depth (the clip's depth map, near = white). With no map the
 * depth is a constant 0.5. An exact identity at amount 0.
 */
import { auxUniforms, GLSL_AUXST } from "../edit/clipAux";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
precision highp sampler2D;
${GLSL_AUXST}
uniform float u_amount; uniform float u_focus; uniform float u_range; uniform float u_blur; uniform float u_short;
void main() {
  vec4 s = texture(u_src, uv);
  if (u_amount <= 0.0) { o = s; return; }
  float coc = max(0.0, abs(depthAt(uv) - u_focus) - u_range) / max(0.05, 1.0 - u_range);
  float r = coc * u_blur * u_amount * 0.03 * u_short;
  if (r < 0.5) { o = s; return; }
  vec4 acc = s; float wsum = 1.0;
  for (int i = 1; i < 28; i++) {
    float a = float(i) * 2.39996323; float rr = sqrt(float(i) / 28.0) * r;
    vec2 p = uv + vec2(cos(a), sin(a)) * rr / u_res;
    float w = 1.0;
    acc += texture(u_src, p) * w; wsum += w;
  }
  o = acc / wsum;
}`;

registerPost({
  type: "tiltshift",
  label: "Depth blur",
  kind: "pass",
  needs: ["depth"],
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    focus: { kind: "number", label: "Focus depth", min: 0, max: 1, default: 0.6 },
    range: { kind: "number", label: "Sharp range", min: 0, max: 0.5, default: 0.15 },
    blur: { kind: "number", label: "Blur", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, w, h) => {
      auxUniforms(ctx.gl, p, 1);
      p.f1("u_amount", f.params.amount as number)
        .f1("u_focus", f.params.focus as number)
        .f1("u_range", f.params.range as number)
        .f1("u_blur", f.params.blur as number)
        .f1("u_short", Math.min(w, h));
    });
  },
});
