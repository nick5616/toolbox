/**
 * Deep glow (FX1): a bright pass into a half-resolution pyramid of 5 levels, blurred while going down and
 * back up, the levels weighted by the radius, added to the picture x amount x tint.
 * Own programs and targets; the maths is in fx1math (glowBright, glowLevelWeights, glowLevelSizes).
 */

/** The pyramid spreads the bright pass thin; this makes amount 1 a clearly visible glow. */
const GLOW_GAIN = 3;
import { FULLSCREEN_VS, Program, Target } from "../gl/core";
import type { FrameInput } from "../layers/registry";
import { hexToLinear } from "../palette";
import { GLOW_LEVELS, glowLevelSizes, glowLevelWeights } from "./fx1math";
import { PASS_HEAD } from "./pass";
import { registerPost, type PostContext, type PostInstance } from "./registry";

/** Down pass: 4 bilinear taps around each destination texel; u_thr >= 0 applies the bright pass per tap. */
const DOWN = `
uniform vec2 u_ts; uniform float u_thr;
vec4 tap(vec2 c) {
  vec4 v = texture(u_src, c);
  if (u_thr >= 0.0) {
    float m = max(v.r, max(v.g, v.b));
    v *= m > 1e-5 ? max(0.0, m - u_thr) / m : 0.0;
  }
  return v;
}
void main() {
  vec2 d = u_ts * 0.5;
  o = (tap(uv + vec2(-d.x, -d.y)) + tap(uv + vec2(d.x, -d.y)) + tap(uv + vec2(-d.x, d.y)) + tap(uv + vec2(d.x, d.y))) * 0.25;
}`;

const TENT = `
vec4 tent(sampler2D t, vec2 c, vec2 ts) {
  vec4 a = texture(t, c + vec2(-ts.x, -ts.y)) + texture(t, c + vec2(ts.x, -ts.y)) + texture(t, c + vec2(-ts.x, ts.y)) + texture(t, c + vec2(ts.x, ts.y));
  vec4 b = texture(t, c + vec2(-ts.x, 0.0)) + texture(t, c + vec2(ts.x, 0.0)) + texture(t, c + vec2(0.0, -ts.y)) + texture(t, c + vec2(0.0, ts.y));
  return (a + b * 2.0 + texture(t, c) * 4.0) * 0.0625;
}`;

/** Up pass: o = a * wa + tent(b) * wb. */
const UP = `
uniform sampler2D u_b; uniform vec2 u_bts; uniform float u_wa; uniform float u_wb;
${TENT}
void main() {
  o = texture(u_src, uv) * u_wa + tent(u_b, uv, u_bts) * u_wb;
}`;

/** Final pass: picture + glow x tint x amount. */
const COMBINE = `
uniform sampler2D u_glow; uniform vec2 u_gts; uniform vec3 u_k;
${TENT}
void main() {
  vec4 s = texture(u_src, uv);
  if (u_k == vec3(0.0)) { o = s; return; }
  vec3 add = tent(u_glow, uv, u_gts).rgb * u_k;
  o = vec4(s.rgb + add, max(s.a, min(1.0, luma(add))));
}`;

function create(ctx: PostContext): PostInstance {
  const gl = ctx.gl;
  const down = new Program(gl, FULLSCREEN_VS, PASS_HEAD + DOWN);
  const up = new Program(gl, FULLSCREEN_VS, PASS_HEAD + UP);
  const combine = new Program(gl, FULLSCREEN_VS, PASS_HEAD + COMBINE);
  let downT: Target[] = [];
  let upT: Target[] = [];

  const ensure = (w: number, h: number) => {
    const sizes = glowLevelSizes(w, h, GLOW_LEVELS);
    if (downT.length === 0) {
      downT = sizes.map(([sw, sh]) => new Target(gl, sw, sh));
      upT = sizes.slice(0, GLOW_LEVELS - 1).map(([sw, sh]) => new Target(gl, sw, sh));
    } else {
      sizes.forEach(([sw, sh], i) => {
        downT[i]?.resize(sw, sh);
        upT[i]?.resize(sw, sh);
      });
    }
  };
  const downPass = (src: Target, dst: Target, thr: number) => {
    dst.bind();
    down.use().tex("u_src", 0, src.tex).f2("u_res", dst.w, dst.h).f2("u_ts", 1 / src.w, 1 / src.h).f1("u_thr", thr);
    ctx.fullscreen.draw();
  };
  const upPass = (a: Target, b: Target, dst: Target, wa: number, wb: number) => {
    dst.bind();
    up.use()
      .tex("u_src", 0, a.tex)
      .tex("u_b", 1, b.tex)
      .f2("u_res", dst.w, dst.h)
      .f2("u_bts", 1 / b.w, 1 / b.h)
      .f1("u_wa", wa)
      .f1("u_wb", wb);
    ctx.fullscreen.draw();
  };

  return {
    render(input: Target, output: Target, f: FrameInput) {
      const amount = f.params.amount as number;
      const tintParam = f.params.tint;
      const tint = typeof tintParam === "string" && tintParam.startsWith("#") ? hexToLinear(tintParam) : ([1, 1, 1] as const);
      ensure(output.w, output.h);
      const d0 = downT[0] as Target;
      let glowTex: Target = d0;
      if (amount > 0) {
        const wts = glowLevelWeights(f.params.radius as number, GLOW_LEVELS);
        downPass(input, d0, f.params.threshold as number);
        for (let i = 1; i < GLOW_LEVELS; i++) downPass(downT[i - 1] as Target, downT[i] as Target, -1);
        const last = GLOW_LEVELS - 1;
        upPass(downT[last - 1] as Target, downT[last] as Target, upT[last - 1] as Target, wts[last - 1] as number, wts[last] as number);
        for (let i = last - 2; i >= 0; i--) {
          upPass(downT[i] as Target, upT[i + 1] as Target, upT[i] as Target, wts[i] as number, 1);
        }
        glowTex = upT[0] as Target;
      }
      output.bind();
      combine
        .use()
        .tex("u_src", 0, input.tex)
        .tex("u_glow", 1, glowTex.tex)
        .f2("u_res", output.w, output.h)
        .f2("u_gts", 1 / glowTex.w, 1 / glowTex.h)
        .f3("u_k", amount > 0 ? [tint[0] * amount * GLOW_GAIN, tint[1] * amount * GLOW_GAIN, tint[2] * amount * GLOW_GAIN] : [0, 0, 0]);
      ctx.fullscreen.draw();
    },
    resize(w: number, h: number) {
      if (downT.length > 0) ensure(w, h);
    },
    dispose() {
      down.dispose();
      up.dispose();
      combine.dispose();
      for (const t of downT) t.dispose();
      for (const t of upT) t.dispose();
      downT = [];
      upT = [];
    },
  };
}

registerPost({
  type: "glow",
  label: "Deep glow",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 3, default: 0 },
    threshold: { kind: "number", label: "Threshold", min: 0, max: 2, default: 0.6 },
    radius: { kind: "number", label: "Radius", min: 0, max: 1, default: 0.5 },
    tint: { kind: "color", label: "Tint", default: "#ffffff" },
  },
  create,
});
