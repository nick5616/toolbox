// Wraps a viz/post pass as a Lab tool: at every dab (evenly spaced along the
// stroke) the area around it is taken from the stroke-start snapshot, run through
// the post effect, and composited back through a soft round mask, so passes
// that overlap compound. It runs on the GPU when the engine gives a GL context
// and on the CPU twin (cpu.ts) otherwise, for the posts that have one.

import type { Rect } from "../engine/types";
import type { FrameInput } from "@/viz/layers/registry";
import { Fullscreen, Target } from "@/viz/gl/core";
import type { PostDef, PostInstance } from "@/viz/post/registry";
import { postDef } from "@/viz/post";
import type { PostType } from "@/viz/types";
import { CPU_POSTS, type CpuPost, type PostParams } from "./cpu";
import { clamp, makeImage, num, Resampler, Serial, stampFalloff, strokeRadius, type Sample } from "./common";
import type { AsyncLabTool } from "./ext";
import type { LabContext, LabParam, LabParams, Predictability } from "./types";

export interface PostToolConfig {
  id: string;
  label: string;
  description: string;
  icon: string;
  type: PostType;
  predictability: Predictability;
  /** Plain-words origin text. */
  origin: string;
  /** One tip per visible param (keys are the post's param ids, plus "reach"). */
  tips: Record<string, string>;
  /** Defaults that replace the post's own (the post's are mostly "off"). */
  defaults?: Record<string, number | string | boolean>;
  /** Post params the user never sees, with the value they always have. */
  fixed?: PostParams;
  /** Post params left out of the Lab panel (they keep their post default or `fixed`). */
  hidden?: string[];
  /** Params that don't exist in the post; `toPost` turns the Lab values into post values. */
  extra?: LabParam[];
  toPost?(lab: LabParams): PostParams;
  /** Per-dab time drives the post's randomness (Glitch): different seeds look different. */
  seededTime?: boolean;
  /** Overrides for the Lab label of a post param. */
  labels?: Record<string, string>;
  /** Replaces a number param's range (the post's ranges assume a whole frame). */
  ranges?: Record<string, { min: number; max: number }>;
}

export interface PostLabTool extends AsyncLabTool {
  postType: PostType;
  /** True when a CPU twin exists (otherwise the tool does nothing without GL). */
  cpu: boolean;
}

/** Lab params for a post def. */
export function labParamsOf(def: PostDef, cfg: PostToolConfig): LabParam[] {
  const out: LabParam[] = [];
  const hidden = new Set([...(cfg.hidden ?? []), ...Object.keys(cfg.fixed ?? {})]);
  for (const [id, spec] of Object.entries(def.params)) {
    if (hidden.has(id) || spec.kind === "color") continue;
    const tip = cfg.tips[id];
    if (!tip) throw new Error(`post tool ${cfg.id}: no tip for ${id}`);
    const label = cfg.labels?.[id] ?? spec.label;
    const dflt = cfg.defaults?.[id];
    if (spec.kind === "number") out.push({ id, label, type: "number", min: cfg.ranges?.[id]?.min ?? spec.min, max: cfg.ranges?.[id]?.max ?? spec.max, step: spec.step, default: typeof dflt === "number" ? dflt : spec.default, tip });
    else if (spec.kind === "enum") out.push({ id, label, type: "choice", choices: spec.options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1) })), default: typeof dflt === "string" ? dflt : spec.default, tip });
    else out.push({ id, label, type: "toggle", default: typeof dflt === "boolean" ? dflt : spec.default, tip });
  }
  out.push(...(cfg.extra ?? []));
  const reachTip = cfg.tips.reach;
  if (!reachTip) throw new Error(`post tool ${cfg.id}: no tip for reach`);
  out.push({ id: "reach", label: "Reach", type: "number", min: 0.6, max: 4, step: 0.1, default: 1.5, tip: reachTip });
  return out;
}

/** The values the post sees. */
function postParams(def: PostDef, cfg: PostToolConfig, lab: LabParams): PostParams {
  const p: PostParams = {};
  for (const [id, spec] of Object.entries(def.params)) p[id] = spec.default;
  for (const [id, v] of Object.entries(lab)) if (id in def.params) p[id] = v;
  if (cfg.toPost) Object.assign(p, cfg.toPost(lab));
  Object.assign(p, cfg.fixed ?? {});
  return p;
}

// ---- GPU ----------------------------------------------------------------------

class GlRunner {
  private readonly fullscreen: Fullscreen;
  private readonly inst: PostInstance;
  private readonly input: Target;
  private readonly output: Target;

  constructor(private readonly gl: WebGL2RenderingContext, def: PostDef, seed: number) {
    if (!def.create) throw new Error(`post ${def.type} cannot run`);
    this.fullscreen = new Fullscreen(gl);
    this.inst = def.create({ gl, fullscreen: this.fullscreen, w: 1, h: 1, seed });
    this.input = new Target(gl, 1, 1, false);
    this.output = new Target(gl, 1, 1, false);
  }

  run(src: ImageData, params: PostParams, seed: number, tMs: number): ImageData {
    const gl = this.gl;
    const w = src.width;
    const h = src.height;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevVp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const blend = gl.isEnabled(gl.BLEND);
    try {
      gl.disable(gl.BLEND);
      this.input.resize(w, h);
      this.output.resize(w, h);
      const pm = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = (src.data[i * 4 + 3] as number) / 255;
        pm[i * 4] = Math.round((src.data[i * 4] as number) * a);
        pm[i * 4 + 1] = Math.round((src.data[i * 4 + 1] as number) * a);
        pm[i * 4 + 2] = Math.round((src.data[i * 4 + 2] as number) * a);
        pm[i * 4 + 3] = src.data[i * 4 + 3] as number;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.input.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pm);
      this.inst.render(this.input, this.output, frameOf(params, w, h, seed, tMs));
      const buf = new Uint8Array(w * h * 4);
      this.output.bind();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const out = makeImage(w, h);
      for (let i = 0; i < w * h; i++) {
        const a = buf[i * 4 + 3] as number;
        for (let c = 0; c < 3; c++) out.data[i * 4 + c] = a > 0 ? Math.min(255, ((buf[i * 4 + c] as number) * 255) / a) : 0;
        out.data[i * 4 + 3] = a;
      }
      return out;
    } finally {
      if (blend) gl.enable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
      gl.activeTexture(prevUnit);
      gl.bindVertexArray(prevVao);
      gl.useProgram(prevProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevVp[0] as number, prevVp[1] as number, prevVp[2] as number, prevVp[3] as number);
    }
  }
}

/** The post passes only read params, size, seed and time (and signals/palette for audio-driven cases we turn off). */
function frameOf(params: PostParams, w: number, h: number, seed: number, tMs: number): FrameInput {
  return {
    tMs,
    dtMs: 0,
    motionSec: tMs / 1000,
    params,
    opacity: 1,
    palette: { bg: [0, 0, 0], colors: [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]], accent: [1, 1, 1], glow: [1, 1, 1] },
    analysis: {},
    signals: { value: () => 0 },
    w,
    h,
    seed,
    quality: "full",
    mode: "opaque",
  } as unknown as FrameInput;
}

const runners = new WeakMap<WebGL2RenderingContext, Map<string, GlRunner>>();
function glRunner(gl: WebGL2RenderingContext, def: PostDef, seed: number): GlRunner {
  let m = runners.get(gl);
  if (!m) {
    m = new Map();
    runners.set(gl, m);
  }
  let r = m.get(def.type);
  if (!r) {
    r = new GlRunner(gl, def, seed);
    m.set(def.type, r);
  }
  return r;
}

/** Runs one dab's effect on `src` using the GPU if given, else the CPU twin; null when neither can. */
export function runPost(def: PostDef, cpu: CpuPost | undefined, gl: WebGL2RenderingContext | null, src: ImageData, params: PostParams, seed: number, tMs: number): ImageData | null {
  if (gl && def.create) return glRunner(gl, def, seed).run(src, params, seed, tMs);
  if (cpu) return cpu(src, params);
  return null;
}

// ---- the tool -----------------------------------------------------------------

export function postTool(cfg: PostToolConfig): PostLabTool {
  const def = postDef(cfg.type);
  if (!def) throw new Error(`post ${cfg.type} is not registered`);
  const cpu = CPU_POSTS[cfg.type];
  const q = new Serial();
  let rs = new Resampler(6);

  const dabs = (ctx: LabContext, samples: Sample[]) => {
    const radius = strokeRadius(ctx);
    const reach = num(ctx.params, "reach", 1.5);
    const params = postParams(def, cfg, ctx.params);
    for (const s of samples) {
      q.run(async () => {
        const r = radius * clamp(0.3 + 0.7 * s.pressure, 0.3, 1);
        const side = Math.max(8, Math.ceil(r * 2 * reach));
        const rect: Rect = { x: Math.round(s.x - side / 2), y: Math.round(s.y - side / 2), w: side, h: side };
        const src = await ctx.snapshot(rect);
        const tMs = cfg.seededTime ? Math.floor(ctx.rng(`post:${s.index}`)() * 9000) : 0;
        const out = runPost(def, cpu, ctx.gl, src, params, ctx.seed, tMs);
        if (!out) return;
        const mask = makeImage(side, side);
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const a = stampFalloff(Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2), r, 0.4);
            const k = (y * side + x) * 4;
            mask.data.fill(255, k, k + 3);
            mask.data[k + 3] = Math.round(a * 255);
          }
        }
        ctx.composite(out, rect, mask);
      });
    }
  };

  return {
    id: cfg.id,
    label: cfg.label,
    description: cfg.description,
    kind: "algorithmic",
    predictability: cfg.predictability,
    origin: { kind: "algorithm", text: cfg.origin },
    params: labParamsOf(def, cfg),
    icon: cfg.icon,
    postType: cfg.type,
    cpu: Boolean(cpu),
    onStrokeBegin(ctx, p) {
      rs = new Resampler(Math.max(2, strokeRadius(ctx) * 0.35));
      rs.begin(p);
    },
    onStrokeExtend(ctx, points) {
      dabs(ctx, rs.push(points));
    },
    onStrokeEnd(ctx) {
      dabs(ctx, rs.finish());
    },
    flush: () => q.flush(),
  };
}
