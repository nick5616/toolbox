/**
 * The Edit Studio engine (Phase 9 SPEC §8.1, §8.4–§8.7): draws the frame of a
 * compiled edit at a timeline time. The preview (DOM canvas) and the export
 * (worker OffscreenCanvas) run this same class.
 *
 * A frame is a function of (project, analysis, markers, size, seed, time):
 * nothing here reads a clock or a random source. `render` is synchronous: it
 * draws whatever the provider holds and never waits for a decode.
 */
import { createContext, Fullscreen, gpuName, Program, FULLSCREEN_VS, Target, type AnyCanvas } from "../gl/core";
import type { ParamValues } from "../layers/registry";
import { beatCount } from "../integral";
import { resolvePalette, type ResolvedPalette } from "../palette";
import "../post";
import { postDef, type PostInstance } from "../post/registry";
import { createTextLayer, type TextLayer } from "../text";
import { Transitions } from "../transitions";
import type { FrameInput } from "../layers/registry";
import type { Analysis } from "../analysis";
import { ClipRenderer, buildMaskUniforms, evalTransform, fitGeometry, resolvePostParams, type ClipDraw, type MatteDraw, type TexEntry } from "./clip";
import { clipAt, clipFramePlan, frameAtTime, isCompiled, needsAt, outgoingOf, transitionMix, type BlendMode, type CompiledClip, type CompiledEditFull, type CompiledTrack, type PlanRef } from "./compile";
import { EditOutput, NO_OUTPUT, type EditOutputParams } from "./output";
import { ImageLRU, Pool } from "./pool";
import { evalEditParam, type ParamContext } from "./params";
import { BLEND_FS, BLIT_FS, MIX_FS, TRACKMATTE_FS } from "./shaders";
import { generatorFor, generatorKey, type GeneratorInstance } from "./generated";
import "./textClip";
import "./visualClip";
import type { CompiledEdit, EditEngineOptions, EditPost, FrameKey, FrameProvider } from "./types";
import { fallBackToBitmap, imageSize, initUploadMode, isClosed, isVideoFrame, uploadFrameImage } from "../frames/upload";
import type { FrameImage } from "../frames/types";

const TEX_CACHE = 24;
const FIT_BLUR_RADIUS = 0.03; // of the short side
const MIN_OPACITY = 0.0005;

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface PostEntry {
  inst: PostInstance;
  seed: number;
}

export class EditEngine {
  readonly gl: WebGL2RenderingContext;
  readonly gpu: string;
  private opts: EditEngineOptions;
  private readonly fs: Fullscreen;
  private readonly clipR: ClipRenderer;
  private readonly output: EditOutput;
  private readonly transitions: Transitions;
  private readonly text: TextLayer;
  private readonly blit: Program;
  private readonly mix: Program;
  private readonly pool: Pool<Target>;
  private readonly texSrgb: ImageLRU<TexEntry>;
  private readonly texLinear: ImageLRU<TexEntry>;
  private readonly posts = new Map<string, PostEntry>();
  /** Part B: generated-clip instances by clip id. */
  private readonly gens = new Map<string, { key: string; inst: GeneratorInstance }>();
  private readonly blendP: Program;
  private readonly matteP: Program;
  private readonly palette: ResolvedPalette;
  private edit: CompiledEditFull | null = null;
  private frameT: Target;
  private uploadChecked = false;
  /** Uploads that failed (tests, Edit Lab). */
  uploadFailures = 0;

  constructor(
    readonly canvas: AnyCanvas,
    opts: EditEngineOptions,
  ) {
    this.opts = { ...opts };
    canvas.width = opts.width;
    canvas.height = opts.height;
    this.gl = createContext(canvas, { alpha: false, preserve: !opts.inWorker });
    this.gpu = gpuName(this.gl);
    initUploadMode(this.gl);
    const gl = this.gl;
    this.fs = new Fullscreen(gl);
    this.clipR = new ClipRenderer(gl, this.fs);
    this.output = new EditOutput(gl, this.fs, opts.width, opts.height);
    this.transitions = new Transitions(gl, this.fs);
    this.text = createTextLayer({ gl, fullscreen: this.fs, w: opts.width, h: opts.height, inWorker: opts.inWorker });
    this.blit = new Program(gl, FULLSCREEN_VS, BLIT_FS);
    this.mix = new Program(gl, FULLSCREEN_VS, MIX_FS);
    this.blendP = new Program(gl, FULLSCREEN_VS, BLEND_FS);
    this.matteP = new Program(gl, FULLSCREEN_VS, TRACKMATTE_FS);
    this.pool = new Pool<Target>(
      (w, h) => new Target(gl, w, h),
      (t) => t.dispose(),
    );
    const destroy = (e: TexEntry) => gl.deleteTexture(e.tex);
    this.texSrgb = new ImageLRU<TexEntry>(TEX_CACHE, destroy);
    this.texLinear = new ImageLRU<TexEntry>(TEX_CACHE, destroy);
    this.palette = resolvePalette({ mode: "fixed", ids: ["mono"] }, null, 0);
    this.frameT = this.pool.acquire(opts.width, opts.height);
  }

  get options(): Readonly<EditEngineOptions> {
    return this.opts;
  }

  setQuality(q: "full" | "draft"): void {
    this.opts.quality = q;
  }

  setEdit(c: CompiledEdit): void {
    this.edit = isCompiled(c) ? c : null;
    // Drop the effect instances of clips and effects that are gone.
    const keep = new Set<string>();
    if (this.edit) {
      for (const t of this.edit.tracks) for (const cl of t.clips) for (const p of cl.effects) keep.add(postKey(`c:${cl.id}`, p));
      for (const p of this.edit.look) keep.add(postKey("look", p));
    }
    for (const [k, e] of this.posts) {
      if (!keep.has(k)) {
        e.inst.dispose();
        this.posts.delete(k);
      }
    }
    // Generated clips: keep instances whose clip (and its kind/JSON) is still there.
    const gk = new Map<string, string>();
    if (this.edit) for (const t of this.edit.tracks) for (const cl of t.clips) if (cl.kind === "text" || cl.kind === "visual") gk.set(cl.id, generatorKey(cl));
    for (const [id, g] of this.gens) {
      if (gk.get(id) !== g.key) {
        g.inst.dispose();
        this.gens.delete(id);
      }
    }
  }

  /** The generator instance of a text/visual clip (built on first use), or null when its kind isn't registered. */
  private generator(cl: CompiledClip): GeneratorInstance | null {
    const key = generatorKey(cl);
    const hit = this.gens.get(cl.id);
    if (hit && hit.key === key) return hit.inst;
    hit?.inst.dispose();
    const make = generatorFor(cl.kind);
    if (!make) return null;
    const { width: w, height: h, inWorker } = this.opts;
    const inst = make({ gl: this.gl, fullscreen: this.fs, w, h, seed: (this.opts.seed ^ fnv(`g:${cl.id}`)) >>> 0, inWorker }, cl);
    this.gens.set(cl.id, { key, inst });
    return inst;
  }

  /** The stream frames (and images) the frame at tMs (timeline ms) uses. */
  needs(tMs: number): FrameKey[] {
    const c = this.edit;
    return c ? needsAt(c, frameAtTime(tMs, c.fps, c.frames)) : [];
  }

  // ---- uploads ----

  private texFor(image: FrameImage, srgb: boolean): TexEntry | null {
    const cache = srgb ? this.texSrgb : this.texLinear;
    const hit = cache.get(image);
    if (hit) return hit;
    if (isClosed(image)) return null;
    const size = imageSize(image);
    if (size.w <= 0 || size.h <= 0) return null;
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    try {
      uploadFrameImage(gl, tex, image, srgb);
      if (!this.uploadChecked) {
        this.uploadChecked = true;
        if (gl.getError() !== gl.NO_ERROR) throw new Error("texImage2D failed");
      }
    } catch {
      gl.deleteTexture(tex);
      this.uploadFailures++;
      if (isVideoFrame(image)) fallBackToBitmap("texImage2D(VideoFrame) failed");
      return null;
    }
    const e: TexEntry = { tex, w: size.w, h: size.h };
    cache.set(image, e);
    return e;
  }

  private refTex(ref: PlanRef, frames: FrameProvider, srgb: boolean): { a: TexEntry; b: TexEntry | null; w: number } | null {
    const get = (f: number): TexEntry | null => {
      const img = ref.image ? frames.image(ref.stream) : frames.frame({ stream: ref.stream, frame: f });
      return img ? this.texFor(img, srgb) : null;
    };
    const a = get(ref.f0);
    if (!a) return null;
    if (ref.w > 0 && ref.f1 !== ref.f0) {
      const b = get(ref.f1);
      if (b) return { a, b, w: ref.w };
    }
    return { a, b: null, w: 0 };
  }

  // ---- small GL helpers ----

  private setBlend(b: BlendMode): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    switch (b) {
      case "add":
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case "screen":
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      case "multiply":
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /** Copies src into dst (no blending). */
  private copy(src: Target, dst: Target): void {
    dst.bind();
    this.gl.disable(this.gl.BLEND);
    this.blit.use().tex("u_src", 0, src.tex);
    this.fs.draw();
  }

  /** Draws src over dst with a blend mode (GL blending for the simple ones, a shader for the rest). */
  private composite(src: Target, dst: Target, blend: BlendMode): void {
    const mode = SHADER_BLENDS.indexOf(blend);
    if (mode < 0) {
      dst.bind();
      this.setBlend(blend);
      this.blit.use().tex("u_src", 0, src.tex);
      this.fs.draw();
      this.gl.disable(this.gl.BLEND);
      return;
    }
    const under = this.pool.acquire(dst.w, dst.h);
    this.copy(dst, under);
    dst.bind();
    this.gl.disable(this.gl.BLEND);
    this.blendP.use().tex("u_src", 0, src.tex).tex("u_dst", 1, under.tex).i1("u_mode", mode);
    this.fs.draw();
    this.pool.release(under);
  }

  private input(params: ParamValues, songMs: number, w: number, h: number, seed: number, analysis?: Analysis): FrameInput {
    const c = this.edit as CompiledEditFull;
    return {
      tMs: songMs,
      dtMs: 1000 / this.opts.fps,
      motionSec: songMs / 1000,
      params,
      opacity: 1,
      palette: this.palette,
      analysis: analysis ?? c.analysis,
      signals: c.signals,
      w,
      h,
      seed,
      quality: this.opts.quality,
      mode: "opaque",
      intensity: 1,
      // Effect params here are resolved per frame (keyframes and marker signals), so a rate is taken as constant over
      // the song's time; beats are the real beat count. Preset layers use the full integrals of viz/integral.ts.
      integral: (name: string) => (typeof params[name] === "number" ? (params[name] as number) : 0) * (songMs / 1000),
      beatIntegral: (name: string) => (typeof params[name] === "number" ? (params[name] as number) : 0) * beatCount(analysis ?? c.analysis, songMs),
    };
  }

  private paramCtx(): ParamContext {
    const c = this.edit as CompiledEditFull;
    return { signals: c.signals, markers: c.markerSignals };
  }

  /** Runs a chain of pass effects over `target` in place (the result is copied back). */
  private runChain(list: readonly EditPost[], prefix: string, target: Target, clipMs: number, songMs: number): void {
    let cur = target;
    let other: Target | null = null;
    const ctx = this.paramCtx();
    for (const pc of list) {
      if (!pc.enabled) continue;
      const def = postDef(pc.type);
      if (!def || def.kind !== "pass" || !def.create || def.stateful) continue;
      const key = postKey(prefix, pc);
      let entry = this.posts.get(key);
      if (!entry) {
        const seed = (this.opts.seed ^ fnv(key)) >>> 0;
        entry = { inst: def.create({ gl: this.gl, fullscreen: this.fs, w: target.w, h: target.h, seed }), seed };
        this.posts.set(key, entry);
      }
      other ??= this.pool.acquire(target.w, target.h);
      const dst = cur === target ? other : target;
      this.gl.disable(this.gl.BLEND);
      entry.inst.render(cur, dst, this.input(resolvePostParams(def.params, pc.params, clipMs, songMs, ctx), songMs, target.w, target.h, entry.seed));
      cur = dst;
    }
    if (other) {
      if (cur !== target) this.copy(cur, target);
      this.pool.release(other);
    }
  }

  private hasEffects(list: readonly EditPost[]): boolean {
    return list.some((p) => {
      if (!p.enabled) return false;
      const d = postDef(p.type);
      return !!d && d.kind === "pass" && !!d.create && !d.stateful;
    });
  }

  // ---- drawing ----

  /**
   * Draws clip `cl` at output frame k into `into` (cleared first): the clip
   * itself, its FxTarget split and its effects. `subjectOnly` draws just the
   * subject (captions behind the subject).
   */
  private drawClip(cl: CompiledClip, k: number, tMs: number, into: Target, frames: FrameProvider, subjectOnly = false): void {
    const c = this.edit as CompiledEditFull;
    const { width: W, height: H } = this.opts;
    const songMs = c.songStartMs + tMs;
    const clipMs = tMs - cl.startMs;
    into.clear(0, 0, 0, 0);
    const ctx = this.paramCtx();
    const tr = evalTransform(cl.transform, W, H, clipMs, songMs, ctx);
    if (tr.opacity <= MIN_OPACITY) return;

    let src0: TexEntry | undefined;
    let src1: TexEntry | null = null;
    let blend = 0;
    let matte: MatteDraw | null = null;
    let srcW = W;
    let srcH = H;
    let genT: Target | null = null;
    const generated = cl.kind === "text" || cl.kind === "visual";
    if (generated) {
      const g = this.generator(cl);
      if (!g) return;
      genT = this.pool.acquire(W, H);
      genT.clear(0, 0, 0, 0);
      genT.bind();
      this.gl.disable(this.gl.BLEND);
      g.render(genT, { clip: cl, clipMs, songMs, markers: c.markers, input: this.input({}, songMs, W, H, this.opts.seed), params: ctx, palette: this.palette });
      this.gl.disable(this.gl.BLEND);
      src0 = { tex: genT.tex, w: W, h: H };
    } else if (cl.kind !== "color") {
      const plan = clipFramePlan(cl, k, c.fps);
      const main = plan.main ? this.refTex(plan.main, frames, true) : null;
      if (!main) return; // not decoded yet: draw nothing rather than the wrong frame
      src0 = main.a;
      src1 = main.b;
      blend = main.w;
      srcW = main.a.w;
      srcH = main.a.h;
      if (cl.matte) {
        const m = plan.matte ? this.refTex(plan.matte, frames, false) : null;
        if (m) {
          matte = {
            tex0: m.a,
            tex1: m.b,
            w: m.w,
            invert: cl.matte.invert,
            cutout: cl.matte.cutout,
            feather: cl.matte.feather,
            strokePx: cl.matte.strokePx,
            strokeColor: cl.matte.strokeColor,
            glowAmount: cl.matte.glowAmount,
            glowColor: cl.matte.glowColor,
          };
        } else if (cl.matte.cutout || subjectOnly) return; // the matte frame isn't here yet
      }
    }
    const geo = cl.kind === "color" ? fitGeometry("fit", W, H, W, H) : generated ? fitGeometry("fill", W, H, W, H) : fitGeometry(cl.fit, srcW, srcH, W, H);
    const masks = cl.masks.length > 0 ? buildMaskUniforms(cl.masks, geo.box, clipMs, songMs, ctx) : null;
    const decor = !!matte && (matte.cutout || cl.fxTarget === "subject") && (matte.strokePx > 0 || matte.glowAmount > 0);
    const split = !!matte && !subjectOnly && cl.fxTarget !== "clip" && this.hasEffects(cl.effects);

    let bg: Target | null = null;
    let bgTmp: Target | null = null;
    if (!generated && cl.kind !== "color" && cl.fit === "fit-blur" && src0 && !matte?.cutout && !subjectOnly) {
      const hw = Math.max(1, W >> 1);
      const hh = Math.max(1, H >> 1);
      bg = this.pool.acquire(hw, hh);
      bgTmp = this.pool.acquire(hw, hh);
      this.clipR.drawCover(bg, src0, src1, blend, cl.flipX, srcW, srcH, W, H);
      const step = (FIT_BLUR_RADIUS * Math.min(W, H) * 0.5) / 3.2;
      this.clipR.blur(bg, bgTmp, step, 0);
      this.clipR.blur(bgTmp, bg, 0, step);
    }

    const draw: ClipDraw = {
      frameW: W,
      frameH: H,
      kind: cl.kind === "color" ? "color" : "image",
      src0,
      src1,
      blend,
      flip: cl.flipX,
      color: cl.color,
      fit: cl.fit,
      fitColor: cl.fitColor,
      geo,
      tr,
      masks,
      matte,
      part: subjectOnly ? 1 : 0,
      decor,
      bg,
      generated,
      edges: cl.transform.edges ?? "clear",
    };
    if (!split) {
      this.clipR.draw(into, draw);
      if (this.hasEffects(cl.effects)) this.runChain(cl.effects, `c:${cl.id}`, into, clipMs, songMs);
    } else {
      const back = this.pool.acquire(W, H);
      const subj = this.pool.acquire(W, H);
      back.clear(0, 0, 0, 0);
      subj.clear(0, 0, 0, 0);
      this.clipR.draw(back, { ...draw, part: 2 });
      this.clipR.draw(subj, { ...draw, part: 1 });
      this.runChain(cl.effects, `c:${cl.id}`, cl.fxTarget === "subject" ? subj : back, clipMs, songMs);
      this.composite(back, into, "normal");
      this.composite(subj, into, "normal");
      this.pool.release(back);
      this.pool.release(subj);
    }
    if (bg) this.pool.release(bg);
    if (bgTmp) this.pool.release(bgTmp);
    if (genT) this.pool.release(genT);
  }

  /** A video-track clip (with its In transition) onto the frame. */
  private drawVideoClip(track: CompiledEditFull["tracks"][number], cl: CompiledClip, k: number, tMs: number, songMs: number, frames: FrameProvider): void {
    const out = this.trackPicture(track, cl, k, tMs, songMs, frames);
    this.composite(out, this.frameT, cl.blend);
    this.pool.release(out);
  }

  /**
   * Part B: a track whose picture shows only where the video track above it
   * (the matte) is opaque or bright. With no matte clip at this frame, an
   * inverted matte shows the track as is and a normal one shows nothing.
   */
  private drawMatted(track: CompiledTrack, cl: CompiledClip, matteTrack: CompiledTrack, k: number, tMs: number, songMs: number, frames: FrameProvider): void {
    const mcl = clipAt(matteTrack, k);
    if (!mcl) {
      if (track.matte.endsWith("inverted")) this.drawVideoClip(track, cl, k, tMs, songMs, frames);
      return;
    }
    const pic = this.trackPicture(track, cl, k, tMs, songMs, frames);
    const mat = this.trackPicture(matteTrack, mcl, k, tMs, songMs, frames);
    const out = this.pool.acquire(pic.w, pic.h);
    out.bind();
    this.gl.disable(this.gl.BLEND);
    const mode = ["alpha", "alpha-inverted", "luma", "luma-inverted"].indexOf(track.matte);
    this.matteP.use().tex("u_src", 0, pic.tex).tex("u_matte", 1, mat.tex).i1("u_mode", Math.max(0, mode));
    this.fs.draw();
    this.composite(out, this.frameT, cl.blend);
    this.pool.release(out);
    this.pool.release(pic);
    this.pool.release(mat);
  }

  /** A track's clip (with its In transition) as a premultiplied picture in a pooled target (the caller releases it). */
  private trackPicture(track: CompiledTrack, cl: CompiledClip, k: number, tMs: number, songMs: number, frames: FrameProvider): Target {
    const { width: W, height: H } = this.opts;
    const mix = transitionMix(cl, tMs, k);
    const out = this.pool.acquire(W, H);
    if (mix === null) {
      this.drawClip(cl, k, tMs, out, frames);
    } else {
      const ta = this.pool.acquire(W, H);
      const tb = this.pool.acquire(W, H);
      const a = outgoingOf(track, cl);
      if (a) this.drawClip(a, k, tMs, ta, frames);
      else ta.clear(0, 0, 0, 0);
      this.drawClip(cl, k, tMs, tb, frames);
      this.transitions.render(cl.transition.kind, ta, tb, mix, out, songMs);
      this.pool.release(ta);
      this.pool.release(tb);
    }
    return out;
  }

  /** An adjustment clip: its effects on the frame so far, mixed back by opacity and masks. */
  private drawAdjust(cl: CompiledClip, tMs: number, songMs: number): void {
    const { width: W, height: H } = this.opts;
    const clipMs = tMs - cl.startMs;
    const ctx = this.paramCtx();
    const amount = evalEditParam(cl.transform.opacity, 0, 1, clipMs, songMs, ctx);
    if (amount <= MIN_OPACITY || !this.hasEffects(cl.effects)) return;
    const processed = this.pool.acquire(W, H);
    this.copy(this.frameT, processed);
    this.runChain(cl.effects, `c:${cl.id}`, processed, clipMs, songMs);
    const res = this.pool.acquire(W, H);
    res.bind();
    this.gl.disable(this.gl.BLEND);
    const p = this.mix.use().tex("u_a", 0, this.frameT.tex).tex("u_b", 1, processed.tex).f1("u_amount", amount).f2("u_frame", W, H);
    this.clipR.setMasks(p, cl.masks.length > 0 ? buildMaskUniforms(cl.masks, [W, H], clipMs, songMs, ctx) : null);
    this.fs.draw();
    this.pool.release(processed);
    this.pool.release(this.frameT);
    this.frameT = res;
  }

  /** Draws and presents the frame at tMs (timeline ms). Synchronous; never waits for a decode. */
  render(tMs: number, frames: FrameProvider): void {
    const c = this.edit;
    const { width: W, height: H } = this.opts;
    if (!c) {
      this.frameT.clear(0, 0, 0, 1);
      this.output.present(this.frameT, this.canvas.width, this.canvas.height, NO_OUTPUT);
      return;
    }
    const k = frameAtTime(tMs, c.fps, c.frames);
    const songMs = c.songStartMs + tMs;
    const bg = c.background;
    this.frameT.clear(bg[0], bg[1], bg[2], 1);

    c.tracks.forEach((t, i) => {
      if (t.muted) return;
      const below = c.tracks[i - 1];
      if (t.isMatte && below && below.matte && !below.muted) return; // drawn as the matte of the track below
      const cl = clipAt(t, k);
      if (!cl) return;
      const above = c.tracks[i + 1];
      if (t.kind === "adjust") this.drawAdjust(cl, tMs, songMs);
      else if (t.matte && above && !above.muted) this.drawMatted(t, cl, above, k, tMs, songMs, frames);
      else this.drawVideoClip(t, cl, k, tMs, songMs, frames);
    });

    const gl = this.gl;
    if (c.captions) {
      this.frameT.bind();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.text.render(this.input({}, songMs, W, H, this.opts.seed, c.captions.analysis), c.captions.style);
      gl.disable(gl.BLEND);
      if (c.captions.behindSubject) this.drawBehindSubject(c, k, tMs, frames);
    }

    if (c.look.length > 0) {
      if (this.hasEffects(c.look)) this.runChain(c.look, "look", this.frameT, tMs, songMs);
      this.output.present(this.frameT, this.canvas.width, this.canvas.height, this.outputParams(c, tMs, songMs), this.opts.quality === "draft");
    } else this.output.present(this.frameT, this.canvas.width, this.canvas.height, { ...NO_OUTPUT, timeSec: songMs / 1000 }, this.opts.quality === "draft");
  }

  /** The topmost matted clip again, subject only, above the captions. */
  private drawBehindSubject(c: CompiledEditFull, k: number, tMs: number, frames: FrameProvider): void {
    const { width: W, height: H } = this.opts;
    for (let i = c.tracks.length - 1; i >= 0; i--) {
      const t = c.tracks[i] as CompiledEditFull["tracks"][number];
      if (t.muted || t.kind !== "video") continue;
      const cl = clipAt(t, k);
      if (!cl || cl.kind === "color" || !cl.matte) continue;
      const out = this.pool.acquire(W, H);
      this.drawClip(cl, k, tMs, out, frames, true);
      this.composite(out, this.frameT, cl.blend);
      this.pool.release(out);
      return;
    }
  }

  private outputParams(c: CompiledEditFull, tMs: number, songMs: number): EditOutputParams {
    const p: EditOutputParams = { ...NO_OUTPUT, timeSec: songMs / 1000 };
    const ctx = this.paramCtx();
    for (const pc of c.look) {
      if (!pc.enabled) continue;
      const def = postDef(pc.type);
      if (!def || def.kind !== "output") continue;
      const v = resolvePostParams(def.params, pc.params, tMs, songMs, ctx);
      if (pc.type === "bloom") {
        p.bloom = v.intensity as number;
        p.threshold = v.threshold as number;
      } else if (pc.type === "vignette") p.vignette = v.amount as number;
      else if (pc.type === "grain") p.grain = v.amount as number;
    }
    return p;
  }

  /** The presented pixels (RGBA, bottom-up), for Edit Lab hashes and tests. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  resize(width: number, height: number): void {
    if (width === this.opts.width && height === this.opts.height) return;
    this.opts.width = width;
    this.opts.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.pool.release(this.frameT);
    this.pool.trim();
    this.frameT = this.pool.acquire(width, height);
    this.output.resize(width, height);
    this.text.resize(width, height);
    for (const e of this.posts.values()) e.inst.resize?.(width, height);
    for (const g of this.gens.values()) g.inst.resize?.(width, height);
  }

  dispose(): void {
    for (const e of this.posts.values()) e.inst.dispose();
    this.posts.clear();
    for (const g of this.gens.values()) g.inst.dispose();
    this.gens.clear();
    this.blendP.dispose();
    this.matteP.dispose();
    this.pool.release(this.frameT);
    this.pool.trim();
    this.texSrgb.clear();
    this.texLinear.clear();
    this.text.dispose();
    this.transitions.dispose();
    this.output.dispose();
    this.clipR.dispose();
    this.blit.dispose();
    this.mix.dispose();
    this.fs.dispose();
    this.edit = null;
  }
}

/** Blend modes drawn with BLEND_FS (index = its u_mode). */
const SHADER_BLENDS: readonly BlendMode[] = ["overlay", "softlight", "hardlight", "difference", "exclusion", "lighten", "darken", "colordodge"];

function postKey(prefix: string, p: EditPost): string {
  return `${prefix}/${p.id}/${p.type}`;
}
