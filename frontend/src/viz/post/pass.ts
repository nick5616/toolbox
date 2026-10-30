/** Shared plumbing for single-fullscreen-pass post effects (PX1). */
import { FULLSCREEN_VS, Program, type Target } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import type { FrameInput } from "../layers/registry";
import type { PostContext, PostInstance } from "./registry";

export const PASS_HEAD = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_res;
${GLSL_COMMON}
`;

/** Builds an instance that draws src to dst with one fragment shader. */
export function simplePass(
  ctx: PostContext,
  body: string,
  setup: (p: Program, f: FrameInput, w: number, h: number) => void,
): PostInstance {
  const prog = new Program(ctx.gl, FULLSCREEN_VS, PASS_HEAD + body);
  return {
    render(input: Target, output: Target, f: FrameInput) {
      output.bind();
      prog.use().tex("u_src", 0, input.tex).f2("u_res", output.w, output.h);
      setup(prog, f, output.w, output.h);
      ctx.fullscreen.draw();
    },
    dispose() {
      prog.dispose();
    },
  };
}
