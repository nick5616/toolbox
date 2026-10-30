/**
 * The engine (SPEC.md §6.1, §6.5): renders the frame of a show at a time.
 * The same class runs the live preview (DOM canvas) and the export (worker
 * OffscreenCanvas), so both produce the same pixels.
 */
import type { Analysis } from "./analysis";
import { activeAt, timelineFor } from "./director";
import { createContext, Fullscreen, gpuName, Target, uploadImage, type AnyCanvas } from "./gl/core";
import { Output, type OutputParams } from "./gl/output";
import "./layers";
import { layerDef, makeRng, type FrameInput, type LayerContext, type LayerInstance, type ParamValues } from "./layers/registry";
import { resolvePalette, type ResolvedPalette } from "./palette";
import "./post";
import { postDef, type PostInstance } from "./post/registry";
import { evalParam, Signals, type ModContext } from "./signals";
import { createTextLayer, type TextLayer } from "./text";
import { Transitions } from "./transitions";
import type { Blend, LayerConfig, PostConfig, Scene, Show, TimelineEntry } from "./types";

export interface EngineOptions {
  width: number;
  height: number;
  mode: "opaque" | "overlay";
  quality: "full" | "draft";
  seed: number;
  fps: number;
  inWorker: boolean;
}

interface SceneTargets {
  cur: Target;
  prev: Target;
}

const WARMUP_MS = 1000;

export class Engine {
  readonly gl: WebGL2RenderingContext;
  readonly gpu: string;
  private readonly fs: Fullscreen;
  private readonly output: Output;
  private readonly transitions: Transitions;
  private readonly text: TextLayer;
  private opts: EngineOptions;
  private show: Show | null = null;
  private analysis: Analysis | null = null;
  private signals: Signals | null = null;
  private entries: TimelineEntry[] = [];
  private readonly sceneTargets = new Map<string, SceneTargets>();
  private readonly instances = new Map<string, LayerInstance>();
  private readonly posts = new Map<string, PostInstance>();
  private frame: Target;
  private scratch: Target;
  private lastT: number | null = null;
  private textures = { cover: null as WebGLTexture | null, image: null as WebGLTexture | null, coverAspect: 1, imageAspect: 1 };
  private currentScene: SceneTargets | null = null;

  constructor(
    readonly canvas: AnyCanvas,
    opts: EngineOptions,
  ) {
    this.opts = { ...opts };
    this.sizeCanvas();
    this.gl = createContext(canvas, { alpha: false, preserve: !opts.inWorker });
    this.gpu = gpuName(this.gl);
    this.fs = new Fullscreen(this.gl);
    this.output = new Output(this.gl, this.fs, opts.width, opts.height);
    this.transitions = new Transitions(this.gl, this.fs);
    this.frame = new Target(this.gl, opts.width, opts.height);
    this.scratch = new Target(this.gl, opts.width, opts.height);
    this.text = createTextLayer({ gl: this.gl, fullscreen: this.fs, w: opts.width, h: opts.height, inWorker: opts.inWorker });
  }

  private sizeCanvas(): void {
    this.canvas.width = this.opts.width;
    this.canvas.height = this.opts.mode === "overlay" ? this.opts.height * 2 : this.opts.height;
  }

  get options(): Readonly<EngineOptions> {
    return this.opts;
  }

  setAnalysis(a: Analysis): void {
    this.analysis = a;
    this.signals = new Signals(a);
    this.refreshTimeline();
    this.lastT = null;
  }

  setShow(show: Show): void {
    this.show = show;
    this.refreshTimeline();
    // Drop instances of layers that are gone.
    const keep = new Set<string>();
    for (const sc of show.scenes) for (const l of sc.layers) keep.add(this.instKey(sc, l));
    for (const [k, inst] of this.instances) {
      if (!keep.has(k)) {
        inst.dispose();
        this.instances.delete(k);
      }
    }
    this.lastT = null;
  }

  setTextures(t: { cover?: TexImageSource | null; image?: TexImageSource | null }): void {
    const gl = this.gl;
    const aspect = (img: TexImageSource) => {
      const o = img as { width?: number; height?: number };
      return o.width && o.height ? o.width / o.height : 1;
    };
    if (t.cover !== undefined) {
      if (this.textures.cover) gl.deleteTexture(this.textures.cover);
      this.textures.cover = t.cover ? uploadImage(gl, t.cover) : null;
      this.textures.coverAspect = t.cover ? aspect(t.cover) : 1;
    }
    if (t.image !== undefined) {
      if (this.textures.image) gl.deleteTexture(this.textures.image);
      this.textures.image = t.image ? uploadImage(gl, t.image) : null;
      this.textures.imageAspect = t.image ? aspect(t.image) : 1;
    }
  }

  setQuality(q: "full" | "draft"): void {
    this.opts.quality = q;
  }

  resize(width: number, height: number): void {
    if (width === this.opts.width && height === this.opts.height) return;
    this.opts.width = width;
    this.opts.height = height;
    this.sizeCanvas();
    this.output.resize(width, height);
    this.frame.resize(width, height);
    this.scratch.resize(width, height);
    for (const t of this.sceneTargets.values()) {
      t.cur.resize(width, height);
      t.prev.resize(width, height);
    }
    for (const inst of this.instances.values()) inst.resize?.(width, height);
    for (const p of this.posts.values()) p.resize?.(width, height);
    this.text.resize(width, height);
    this.lastT = null;
  }

  private refreshTimeline(): void {
    this.entries = this.analysis && this.show ? timelineFor(this.analysis, this.show) : [];
  }

  /** The timeline in effect (for the Song Map and the Why readout). */
  timeline(): TimelineEntry[] {
    return this.entries;
  }

  private instKey(sc: Scene, l: LayerConfig): string {
    return `${sc.id}/${l.id}/${l.type}`;
  }

  private hasStateful(): boolean {
    if (!this.show) return false;
    return this.show.scenes.some((s) => s.layers.some((l) => l.enabled && layerDef(l.type)?.stateful) || s.post.some((p) => p.enabled && postDef(p.type)?.stateful)) || this.show.post.some((p) => p.enabled && postDef(p.type)?.stateful);
  }

  /** Renders and presents the frame at tMs. */
  render(tMs: number): void {
    const frameMs = 1000 / this.opts.fps;
    if (this.lastT !== null && this.hasStateful() && (tMs < this.lastT || tMs - this.lastT > frameMs * 2.5)) {
      for (let t = Math.max(0, tMs - WARMUP_MS); t < tMs - frameMs / 2; t += frameMs) this.renderFrame(t);
    } else if (this.lastT === null && this.hasStateful() && tMs > 0) {
      for (let t = Math.max(0, tMs - WARMUP_MS); t < tMs - frameMs / 2; t += frameMs) this.renderFrame(t);
    }
    this.renderFrame(tMs);
    this.present(tMs);
    this.lastT = tMs;
  }

  private modContext(): ModContext | null {
    if (!this.show || !this.signals) return null;
    return { signals: this.signals, mix: this.show.mix, reactivity: this.show.reactivity };
  }

  private targetsFor(sceneId: string): SceneTargets {
    let t = this.sceneTargets.get(sceneId);
    if (!t) {
      t = { cur: new Target(this.gl, this.opts.width, this.opts.height), prev: new Target(this.gl, this.opts.width, this.opts.height) };
      this.sceneTargets.set(sceneId, t);
    }
    return t;
  }

  private setBlend(b: Blend): void {
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

  private resolveParams(specs: Record<string, import("./layers/registry").ParamSpec>, raw: Record<string, unknown>, tMs: number, mc: ModContext): ParamValues {
    const out: ParamValues = {};
    for (const [k, spec] of Object.entries(specs)) {
      const v = raw[k];
      if (spec.kind === "number") {
        const p = typeof v === "number" || (typeof v === "object" && v !== null) ? (v as import("./types").Param) : spec.default;
        out[k] = evalParam(p, spec.min, spec.max, tMs, mc);
      } else if (spec.kind === "bool") out[k] = typeof v === "boolean" ? v : spec.default;
      else out[k] = typeof v === "string" ? v : spec.default;
    }
    return out;
  }

  private frameInput(tMs: number, params: ParamValues, opacity: number, palette: ResolvedPalette): FrameInput {
    const a = this.analysis as Analysis;
    return {
      tMs,
      dtMs: 1000 / this.opts.fps,
      motionSec: (tMs / 1000) * (this.show?.speed ?? 1),
      params,
      opacity,
      palette,
      analysis: a,
      signals: this.signals as Signals,
      w: this.opts.width,
      h: this.opts.height,
      seed: this.opts.seed,
      quality: this.opts.quality,
      mode: this.opts.mode,
    };
  }

  private layerContext(): LayerContext {
    return {
      gl: this.gl,
      fullscreen: this.fs,
      w: this.opts.width,
      h: this.opts.height,
      seed: this.opts.seed,
      rng: (key) => makeRng(this.opts.seed, key),
      textures: this.textures,
      previous: () => this.currentScene?.prev ?? null,
    };
  }

  private runPosts(list: PostConfig[], target: Target, tMs: number, palette: ResolvedPalette, mc: ModContext, keyPrefix: string): Target {
    let src = target;
    for (const pc of list) {
      if (!pc.enabled) continue;
      const def = postDef(pc.type);
      if (!def || def.kind !== "pass" || !def.create) continue;
      const key = `${keyPrefix}/${pc.id}/${pc.type}`;
      let inst = this.posts.get(key);
      if (!inst) {
        inst = def.create({ gl: this.gl, fullscreen: this.fs, w: this.opts.width, h: this.opts.height, seed: this.opts.seed });
        this.posts.set(key, inst);
      }
      const dst = src === this.scratch ? target : this.scratch;
      this.gl.disable(this.gl.BLEND);
      inst.render(src, dst, this.frameInput(tMs, this.resolveParams(def.params, pc.params, tMs, mc), 1, palette));
      src = dst;
    }
    return src;
  }

  private renderScene(entry: TimelineEntry, tMs: number, mc: ModContext): Target {
    const show = this.show as Show;
    const scene = show.scenes.find((s) => s.id === entry.sceneId) ?? (show.scenes[0] as Scene);
    const tg = this.targetsFor(scene.id);
    [tg.cur, tg.prev] = [tg.prev, tg.cur];
    this.currentScene = tg;
    const palette = resolvePalette(show.palette, this.analysis, tMs, entry.paletteId);
    if (this.opts.mode === "overlay") tg.cur.clear(0, 0, 0, 0);
    else tg.cur.clear(palette.bg[0], palette.bg[1], palette.bg[2], 1);
    for (const l of scene.layers) {
      if (!l.enabled) continue;
      const def = layerDef(l.type);
      if (!def) continue;
      if (this.opts.mode === "overlay" && def.group === "background") continue;
      const key = this.instKey(scene, l);
      let inst = this.instances.get(key);
      if (!inst) {
        inst = def.create(this.layerContext());
        this.instances.set(key, inst);
      }
      const opacity = evalParam(l.opacity, 0, 1, tMs, mc);
      if (opacity <= 0.001) continue;
      tg.cur.bind();
      this.setBlend(l.blend);
      inst.render(this.frameInput(tMs, this.resolveParams(def.params, l.params, tMs, mc), opacity, palette));
    }
    this.currentScene = null;
    return this.runPosts(scene.post, tg.cur, tMs, palette, mc, `scene:${scene.id}`);
  }

  private renderFrame(tMs: number): void {
    const gl = this.gl;
    const mc = this.modContext();
    const active = activeAt(this.entries, tMs);
    if (!this.show || !this.analysis || !mc || !active) {
      this.frame.clear(0, 0, 0, this.opts.mode === "overlay" ? 0 : 1);
      return;
    }
    const cur = this.renderScene(active.current, tMs, mc);
    if (active.previous) {
      const prevTarget = this.renderScene(active.previous, tMs, mc);
      this.transitions.render(active.current.transition.kind, prevTarget, cur, active.mix, this.frame, tMs);
    } else {
      this.transitions.render("cut", cur, cur, 1, this.frame, tMs);
    }
    const palette = resolvePalette(this.show.palette, this.analysis, tMs, active.current.paletteId);
    if (this.show.text) {
      this.frame.bind();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.text.render(this.frameInput(tMs, {}, 1, palette), this.show.text);
    }
    const out = this.runPosts(this.show.post, this.frame, tMs, palette, mc, "global");
    if (out !== this.frame) this.transitions.render("cut", out, out, 1, this.frame, tMs);
  }

  private outputParams(tMs: number): OutputParams {
    const p: OutputParams = { bloom: 0, threshold: 0.8, vignette: 0, grain: 0, exposure: 1, timeSec: tMs / 1000 };
    const mc = this.modContext();
    if (!this.show || !mc) return p;
    for (const pc of this.show.post) {
      if (!pc.enabled) continue;
      const def = postDef(pc.type);
      if (!def || def.kind !== "output") continue;
      const v = this.resolveParams(def.params, pc.params, tMs, mc);
      if (pc.type === "bloom") {
        p.bloom = v.intensity as number;
        p.threshold = v.threshold as number;
      } else if (pc.type === "vignette") p.vignette = v.amount as number;
      else if (pc.type === "grain") p.grain = v.amount as number;
    }
    return p;
  }

  private present(tMs: number): void {
    this.output.present(this.frame, this.canvas.width, this.canvas.height, this.opts.mode === "overlay", this.outputParams(tMs), this.opts.quality === "draft");
  }

  /** The presented pixels (RGBA, bottom-up), for VizLab hashes and tests. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  dispose(): void {
    for (const i of this.instances.values()) i.dispose();
    for (const p of this.posts.values()) p.dispose();
    for (const t of this.sceneTargets.values()) {
      t.cur.dispose();
      t.prev.dispose();
    }
    this.instances.clear();
    this.posts.clear();
    this.sceneTargets.clear();
    this.text.dispose();
    this.transitions.dispose();
    this.output.dispose();
    this.frame.dispose();
    this.scratch.dispose();
    this.fs.dispose();
    if (this.textures.cover) this.gl.deleteTexture(this.textures.cover);
    if (this.textures.image) this.gl.deleteTexture(this.textures.image);
  }
}
