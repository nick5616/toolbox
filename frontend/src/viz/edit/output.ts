/**
 * The edit's output pass (SPEC §8.4 step 4): the Look's bloom, vignette and
 * grain, then linear → sRGB with a dither, written to the canvas. Same bloom
 * as gl/output.ts, but the final stage has no tone mapping (see shaders.ts).
 */
import { FULLSCREEN_VS, Program, Target, type Fullscreen } from "../gl/core";
import { BLOOM_DOWN_FS, BLOOM_PRE_FS, BLOOM_UP_FS, EDIT_FINAL_FS } from "./shaders";

export interface EditOutputParams {
  bloom: number; // 0..2
  threshold: number; // 0.3..2
  vignette: number; // 0..1
  grain: number; // 0..1
  timeSec: number;
}

export const NO_OUTPUT: EditOutputParams = { bloom: 0, threshold: 0.8, vignette: 0, grain: 0, timeSec: 0 };

export class EditOutput {
  private readonly pre: Program;
  private readonly down: Program;
  private readonly up: Program;
  private readonly fin: Program;
  private levels: Target[] = [];

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly fs: Fullscreen,
    w: number,
    h: number,
    private readonly levelCount = 6,
  ) {
    this.pre = new Program(gl, FULLSCREEN_VS, BLOOM_PRE_FS);
    this.down = new Program(gl, FULLSCREEN_VS, BLOOM_DOWN_FS);
    this.up = new Program(gl, FULLSCREEN_VS, BLOOM_UP_FS);
    this.fin = new Program(gl, FULLSCREEN_VS, EDIT_FINAL_FS);
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    let lw = Math.max(1, w >> 1);
    let lh = Math.max(1, h >> 1);
    for (let i = 0; i < this.levelCount; i++) {
      this.levels.push(new Target(this.gl, lw, lh));
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
  }

  /** Writes `scene` to the default framebuffer (outW × outH). Bloom runs only when its amount is above 0. */
  present(scene: Target, outW: number, outH: number, p: EditOutputParams, draftBloom = false): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const levels = draftBloom ? this.levels.slice(1) : this.levels;
    const first = levels[0] as Target;
    if (p.bloom > 0) {
      first.bind();
      this.pre.use().tex("u_src", 0, scene.tex).f2("u_texel", 1 / scene.w, 1 / scene.h).f1("u_threshold", p.threshold).f1("u_knee", 0.5);
      this.fs.draw();
      for (let i = 1; i < levels.length; i++) {
        const src = levels[i - 1] as Target;
        const dst = levels[i] as Target;
        dst.bind();
        this.down.use().tex("u_src", 0, src.tex).f2("u_texel", 1 / src.w, 1 / src.h);
        this.fs.draw();
      }
      gl.enable(gl.BLEND);
      gl.blendColor(0.6, 0.6, 0.6, 1);
      gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE);
      for (let i = levels.length - 1; i > 0; i--) {
        const src = levels[i] as Target;
        const dst = levels[i - 1] as Target;
        dst.bind();
        this.up.use().tex("u_src", 0, src.tex).f2("u_texel", 1 / src.w, 1 / src.h);
        this.fs.draw();
      }
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    this.fin
      .use()
      .tex("u_scene", 0, scene.tex)
      .tex("u_bloom", 1, first.tex)
      .f1("u_bloomAmt", p.bloom > 0 ? p.bloom * 0.4 : 0)
      .f1("u_vignette", p.vignette)
      .f1("u_grain", p.grain)
      .f1("u_time", p.timeSec)
      .f2("u_size", scene.w, scene.h);
    this.fs.draw();
  }

  dispose(): void {
    for (const t of this.levels) t.dispose();
    this.pre.dispose();
    this.down.dispose();
    this.up.dispose();
    this.fin.dispose();
  }
}
