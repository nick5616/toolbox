/**
 * Feedback trails (SPEC.md §6.7, stateful): the previous output is zoomed,
 * rotated and faded, then the new frame is laid over it with a per-channel max.
 * Owns one history target; two passes' worth of work (one draw + one blit).
 */
import { FULLSCREEN_VS, Program, Target } from "../gl/core";
import { PASS_HEAD } from "./pass";
import { frameDecay } from "./px1math";
import { registerPost } from "./registry";

const SRC = `
uniform sampler2D u_hist;
uniform float u_decay; uniform float u_zoom; uniform float u_rot;
void main() {
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - 0.5) * u_res / s;
  float c = cos(u_rot), sn = sin(u_rot);
  p = mat2(c, -sn, sn, c) * p / u_zoom;
  vec2 huv = p * s / u_res + 0.5;
  vec4 h = texture(u_hist, huv) * u_decay;
  if (huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0) h = vec4(0.0);
  vec4 n = texture(u_src, uv);
  o = vec4(max(n.rgb, h.rgb), max(n.a, h.a));
}`;

registerPost({
  type: "feedback",
  label: "Feedback trails",
  kind: "pass",
  stateful: true,
  params: {
    decay: { kind: "number", label: "Persistence", min: 0.3, max: 0.97, default: 0.84 },
    zoom: { kind: "number", label: "Zoom drift", min: -0.03, max: 0.06, default: 0.01 },
    rotate: { kind: "number", label: "Rotation drift", min: -0.05, max: 0.05, default: 0.004 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const prog = new Program(gl, FULLSCREEN_VS, PASS_HEAD + SRC);
    const hist = new Target(gl, ctx.w, ctx.h);
    hist.clear();
    return {
      render(input, output, f) {
        if (hist.w !== output.w || hist.h !== output.h) {
          hist.resize(output.w, output.h);
          hist.clear();
        }
        const dt = Math.max(1, Math.min(100, f.dtMs || 1000 / 60)) / (1000 / 60);
        output.bind();
        prog
          .use()
          .tex("u_src", 0, input.tex)
          .tex("u_hist", 1, hist.tex)
          .f2("u_res", output.w, output.h)
          .f1("u_decay", frameDecay(f.params.decay as number, f.dtMs))
          .f1("u_zoom", 1 + (f.params.zoom as number) * dt)
          .f1("u_rot", (f.params.rotate as number) * dt);
        ctx.fullscreen.draw();
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, output.fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hist.fb);
        gl.blitFramebuffer(0, 0, output.w, output.h, 0, 0, hist.w, hist.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      resize(w, h) {
        hist.resize(w, h);
        hist.clear();
      },
      dispose() {
        prog.dispose();
        hist.dispose();
      },
    };
  },
});
