/**
 * Depth fog (Color Grader): colours the distance. Reads the clip's depth map (near = white); with no map the
 * depth is a constant 0.5. An exact identity at amount 0.
 */
import { auxUniforms, GLSL_AUXST } from "../edit/clipAux";
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
precision highp sampler2D;
${GLSL_AUXST}
uniform float u_amount; uniform vec3 u_col; uniform float u_start; uniform float u_density;
void main() {
  vec4 s = texture(u_src, uv);
  if (u_amount <= 0.0) { o = s; return; }
  float dist = 1.0 - depthAt(uv);
  float f = smoothstep(u_start, 1.0, dist) * u_density * u_amount;
  o = vec4(mix(s.rgb, u_col * s.a, clamp(f, 0.0, 1.0)), s.a);
}`;

registerPost({
  type: "depthfog",
  label: "Depth fog",
  kind: "pass",
  needs: ["depth"],
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    color: { kind: "color", label: "Colour", default: "#ff9ed8" },
    start: { kind: "number", label: "Starts at", min: 0, max: 1, default: 0.4 },
    density: { kind: "number", label: "Density", min: 0, max: 1, default: 0.6 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      auxUniforms(ctx.gl, p, 1);
      p.f1("u_amount", f.params.amount as number)
        .f3("u_col", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_start", Math.min(0.999, f.params.start as number))
        .f1("u_density", f.params.density as number);
    });
  },
});
