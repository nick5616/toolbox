/**
 * Halation (Color Grader): the coloured film glow around bright areas. A bright pass into a half-size target,
 * blurred three times with growing steps, tinted and added back. An exact identity at amount 0.
 */
import { FULLSCREEN_VS, Program, Target } from "../gl/core";
import type { FrameInput } from "../layers/registry";
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { PASS_HEAD } from "./pass";
import { registerPost, type PostContext, type PostInstance } from "./registry";

/** Bright pass: keeps what is above the threshold (linear, per brightest channel). */
const BRIGHT = `
uniform float u_thr;
void main() {
  vec4 c = texture(u_src, uv);
  float m = max(c.r, max(c.g, c.b));
  o = c * (m > 1e-5 ? max(0.0, m - u_thr) / m : 0.0);
}`;

/** One direction of a 9-tap gaussian; u_step is in source texels. */
const BLUR = `
uniform vec2 u_step;
void main() {
  vec4 c = texture(u_src, uv) * 0.2270270270;
  c += (texture(u_src, uv + u_step * 1.3846153846) + texture(u_src, uv - u_step * 1.3846153846)) * 0.3162162162;
  c += (texture(u_src, uv + u_step * 3.2307692308) + texture(u_src, uv - u_step * 3.2307692308)) * 0.0702702703;
  o = c;
}`;

const COMBINE = `
uniform sampler2D u_glow; uniform vec3 u_k;
void main() {
  vec4 s = texture(u_src, uv);
  if (u_k == vec3(0.0)) { o = s; return; }
  vec3 add = texture(u_glow, uv).rgb * u_k;
  o = vec4(s.rgb + add, max(s.a, min(1.0, luma(add))));
}`;

/** amount 1 should be a clear glow: the blurred bright pass is thin. */
const GAIN = 3;

function create(ctx: PostContext): PostInstance {
  const gl = ctx.gl;
  const bright = new Program(gl, FULLSCREEN_VS, PASS_HEAD + BRIGHT);
  const blur = new Program(gl, FULLSCREEN_VS, PASS_HEAD + BLUR);
  const combine = new Program(gl, FULLSCREEN_VS, PASS_HEAD + COMBINE);
  let a: Target | null = null;
  let b: Target | null = null;

  const half = (w: number, h: number): [number, number] => [Math.max(1, w >> 1), Math.max(1, h >> 1)];
  const ensure = (w: number, h: number): [Target, Target] => {
    const [hw, hh] = half(w, h);
    if (!a || !b) {
      a = new Target(gl, hw, hh);
      b = new Target(gl, hw, hh);
    } else {
      a.resize(hw, hh);
      b.resize(hw, hh);
    }
    return [a, b];
  };

  return {
    render(input: Target, output: Target, f: FrameInput) {
      const amount = f.params.amount as number;
      const tint = paletteRef(f.palette, f.params.tint as string, hexToLinear);
      const [ta, tb] = ensure(output.w, output.h);
      if (amount > 0) {
        ta.bind();
        bright.use().tex("u_src", 0, input.tex).f2("u_res", ta.w, ta.h).f1("u_thr", f.params.threshold as number);
        ctx.fullscreen.draw();
        const base = (0.6 + 3.4 * (f.params.radius as number)) * Math.max(0.5, output.h / 1080);
        let src = ta;
        let dst = tb;
        for (const k of [1, 2.2, 4.5]) {
          for (const dir of [[1, 0], [0, 1]] as const) {
            dst.bind();
            blur.use().tex("u_src", 0, src.tex).f2("u_res", dst.w, dst.h).f2("u_step", (dir[0] * base * k) / src.w, (dir[1] * base * k) / src.h);
            ctx.fullscreen.draw();
            [src, dst] = [dst, src];
          }
        }
        // after an even number of passes the result is back in `ta`
      }
      output.bind();
      combine
        .use()
        .tex("u_src", 0, input.tex)
        .tex("u_glow", 1, ta.tex)
        .f2("u_res", output.w, output.h)
        .f3("u_k", amount > 0 ? [tint[0] * amount * GAIN, tint[1] * amount * GAIN, tint[2] * amount * GAIN] : [0, 0, 0]);
      ctx.fullscreen.draw();
    },
    resize(w: number, h: number) {
      if (a && b) ensure(w, h);
    },
    dispose() {
      bright.dispose();
      blur.dispose();
      combine.dispose();
      a?.dispose();
      b?.dispose();
      a = b = null;
    },
  };
}

registerPost({
  type: "halation",
  label: "Halation",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    threshold: { kind: "number", label: "Threshold", min: 0, max: 1, default: 0.55 },
    radius: { kind: "number", label: "Radius", min: 0, max: 1, default: 0.5 },
    tint: { kind: "color", label: "Tint", default: "#ff5a2a" },
  },
  create,
});
