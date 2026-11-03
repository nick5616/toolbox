/** Blur pulse (ES5): separable Gaussian blur (two passes through an internal target) whose radius follows the amount. */
import { FULLSCREEN_VS, Program, Target } from "../gl/core";
import type { FrameInput } from "../layers/registry";
import { PASS_HEAD } from "./pass";
import { blurSigmaPx, blurStepPx, gaussWeights } from "./px2math";
import { registerPost, type PostContext, type PostInstance } from "./registry";

const TAPS = 8;
const SRC = `
uniform vec2 u_dir; uniform float u_w[${TAPS + 1}]; uniform float u_step;
void main() {
  vec4 acc = texture(u_src, uv) * u_w[0];
  for (int i = 1; i <= ${TAPS}; i++) {
    vec2 d = u_dir * (float(i) * u_step) / u_res;
    acc += (texture(u_src, uv + d) + texture(u_src, uv - d)) * u_w[i];
  }
  o = acc;
}`;

function create(ctx: PostContext): PostInstance {
  const gl = ctx.gl;
  const prog = new Program(gl, FULLSCREEN_VS, PASS_HEAD + SRC);
  let tmp: Target | null = null;
  const weights = new Float32Array(TAPS + 1);
  const pass = (src: Target, dst: Target, dx: number, dy: number, step: number) => {
    dst.bind();
    prog.use().tex("u_src", 0, src.tex).f2("u_res", dst.w, dst.h).f2("u_dir", dx, dy).f1("u_step", step).fv("u_w", weights);
    ctx.fullscreen.draw();
  };
  return {
    render(input: Target, output: Target, f: FrameInput) {
      const sigma = blurSigmaPx(f.params.radius as number, f.params.amount as number, Math.min(output.w, output.h));
      if (sigma < 0.3) {
        // Too small to see: a single-tap copy keeps the chain contract (output written).
        weights.fill(0);
        weights[0] = 1;
        pass(input, output, 1, 0, 1);
        return;
      }
      const step = blurStepPx(sigma);
      weights.set(gaussWeights(sigma, step, TAPS));
      if (!tmp) tmp = new Target(gl, output.w, output.h);
      else tmp.resize(output.w, output.h);
      pass(input, tmp, 1, 0, step);
      pass(tmp, output, 0, 1, step);
    },
    resize(w: number, h: number) {
      tmp?.resize(w, h);
    },
    dispose() {
      prog.dispose();
      tmp?.dispose();
      tmp = null;
    },
  };
}

registerPost({
  type: "blurpulse",
  label: "Blur pulse",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    radius: { kind: "number", label: "Radius", min: 0, max: 0.05, default: 0.02 },
  },
  create,
});
