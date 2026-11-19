/**
 * Clip auxiliary maps (Phase 21 SPEC §E5): depth and subject maps that
 * effects can read. The contract (types, AUX_UNIFORMS, GLSL_AUX) is FROZEN
 * since Wave 0; G1 implements the binding below it, and E4's clip renderer
 * calls it before running a clip's effects.
 *
 * - `EditFiles` keys: `d:<depthId>` is a depth edit stream (grey, near =
 *   white), `a:<path>` a still map PNG (depth or subject alpha).
 * - Passes that need a map declare `needs` in their PostDef; the clip renderer
 *   binds `u_depth` / `u_subject` (r channel 0..1, in the clip's source UV)
 *   and `u_hasDepth` / `u_hasSubject` (0/1).
 * - A missing map is a constant: depth 0.5, subject 1.
 */
import type { Program } from "../gl/core";
import type { FrameImage, FrameKey, FrameProvider } from "../frames/types";
import { imageSize, isClosed, uploadFrameImage } from "../frames/upload";

export type AuxKind = "depth" | "subject" | "people";

/** Where a clip's maps come from. */
export interface ClipAux {
  /** Depth: a stream id (EditFiles `d:<id>`) for videos, or a PNG path (`a:<path>`) for pictures. */
  depth?: { stream: string } | { still: string };
  /** Subject alpha: a matte stream (the clip's Matte) or a PNG (Background Remover alpha). */
  subject?: { matte: string } | { still: string };
  people?: { matte: string } | { still: string };
}

/** Uniform names a pass with `needs` can read. */
export const AUX_UNIFORMS = {
  depth: { tex: "u_depth", has: "u_hasDepth" },
  subject: { tex: "u_subject", has: "u_hasSubject" },
  people: { tex: "u_people", has: "u_hasPeople" },
} as const;

/** GLSL helpers every aux-reading pass can include. */
export const GLSL_AUX = `
uniform sampler2D u_depth; uniform float u_hasDepth;
uniform sampler2D u_subject; uniform float u_hasSubject;
uniform sampler2D u_people; uniform float u_hasPeople;
float auxDepth(vec2 uv) { return u_hasDepth > 0.5 ? texture(u_depth, uv).r : 0.5; }
float auxSubject(vec2 uv) { return u_hasSubject > 0.5 ? texture(u_subject, uv).r : 1.0; }
float auxPeople(vec2 uv) { return u_hasPeople > 0.5 ? texture(u_people, uv).r : 1.0; }
`;

// ---------------------------------------------------------------------------------------------------------
// G1: binding (everything below the frozen contract).
//
// How a pass reads a map: passes that declare `needs` (viz/post/registry.ts PostDef.needs) call
// `auxUniforms(gl, program, firstUnit)` from their `render`, which binds `u_depth`/`u_subject`/`u_people`
// (r channel 0..1) to three texture units from `firstUnit` and sets `u_hasDepth`/`u_hasSubject`/`u_hasPeople`
// and `u_auxUV`; the GLSL helpers in `GLSL_AUXST` (depthAt/subjectAt/peopleAt of a frame uv) do the sampling.
// What a pass sees is whatever the clip renderer last bound with `bindAux(gl, …)`:
//
//   bindAux(gl, resolveAux(cache, clipAuxOf(clip, files), frame, frames, uv));   // before runChain
//   …runChain…
//   bindAux(gl, null);                                                            // after
//
// A missing map is a constant (depth 0.5, subject 1, people 1).
// ---------------------------------------------------------------------------------------------------------

/** A map texture (single channel in r, uploaded like source frames: top row first, linear). */
export interface AuxTex {
  tex: WebGLTexture;
}

/** What is bound for the next effects chain. */
export interface AuxBinding {
  depth?: AuxTex | null;
  subject?: AuxTex | null;
  people?: AuxTex | null;
  /**
   * Frame → map coordinates: the map is sampled at `vec2(u, 1 - v) * (sx, sy) + (ox, oy)` for a frame uv (u, v)
   * (v up). The default (1, 1, 0, 0) is right when the clip fills the frame at its own aspect, as in Color
   * Grader; a clip with a transform or a fit passes the mapping of its drawn rect.
   */
  uv?: readonly [number, number, number, number];
}

const bound = new WeakMap<WebGL2RenderingContext, AuxBinding>();
const dummies = new WeakMap<WebGL2RenderingContext, WebGLTexture>();

/** Sets (or, with null, clears) the maps the passes of this context see. */
export function bindAux(gl: WebGL2RenderingContext, aux: AuxBinding | null): void {
  if (aux) bound.set(gl, aux);
  else bound.delete(gl);
}

/** The current binding (tests). */
export function boundAux(gl: WebGL2RenderingContext): AuxBinding | null {
  return bound.get(gl) ?? null;
}

function dummy(gl: WebGL2RenderingContext): WebGLTexture {
  let t = dummies.get(gl);
  if (!t) {
    t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    dummies.set(gl, t);
  }
  return t;
}

/** Binds the maps to units firstUnit..firstUnit+2 of a program that declares GLSL_AUXST, and sets the flags. */
export function auxUniforms(gl: WebGL2RenderingContext, p: Program, firstUnit: number): void {
  const a = bound.get(gl);
  const maps: Array<[AuxKind, AuxTex | null | undefined]> = [
    ["depth", a?.depth],
    ["subject", a?.subject],
    ["people", a?.people],
  ];
  maps.forEach(([kind, t], i) => {
    p.tex(AUX_UNIFORMS[kind].tex, firstUnit + i, t ? t.tex : dummy(gl));
    p.i1(AUX_UNIFORMS[kind].has, t ? 1 : 0);
  });
  const uv = a?.uv ?? [1, 1, 0, 0];
  p.f4("u_auxUV", uv[0], uv[1], uv[2], uv[3]);
  gl.activeTexture(gl.TEXTURE0);
}

/** GLSL for passes with `needs`: the frozen GLSL_AUX uniforms plus u_auxUV and samplers of a frame uv (v up). */
export const GLSL_AUXST = `${GLSL_AUX}
uniform vec4 u_auxUV;
vec2 auxST(vec2 p) { return vec2(p.x, 1.0 - p.y) * u_auxUV.xy + u_auxUV.zw; }
float depthAt(vec2 p) { return u_hasDepth > 0.5 ? textureLod(u_depth, auxST(p), 0.0).r : 0.5; }
float subjectAt(vec2 p) { return u_hasSubject > 0.5 ? textureLod(u_subject, auxST(p), 0.0).r : 1.0; }
float peopleAt(vec2 p) { return u_hasPeople > 0.5 ? textureLod(u_people, auxST(p), 0.0).r : 1.0; }
`;

// ---- where a clip's maps come from ----

/** A map reference: an EditFiles key (a stream's frame, or an image). */
export interface AuxRef {
  key: string;
  /** A still PNG (EditFiles.images) rather than a stream frame. */
  image: boolean;
}

export type AuxRefs = Partial<Record<AuxKind, AuxRef>>;

/** The EditFiles keys of a clip's maps. */
export function auxRefs(aux: ClipAux | undefined): AuxRefs {
  const out: AuxRefs = {};
  if (!aux) return out;
  // A `still` that already is an EditFiles key (`a:`, `d:` or `m:` prefix) is used as it is (clipAuxOf does that).
  const still = (s: string): AuxRef => ({ key: /^[adm]:/.test(s) ? s : `a:${s}`, image: true });
  if (aux.depth) out.depth = "stream" in aux.depth ? { key: `d:${aux.depth.stream}`, image: false } : still(aux.depth.still);
  if (aux.subject) out.subject = "matte" in aux.subject ? { key: `m:${aux.subject.matte}`, image: false } : still(aux.subject.still);
  if (aux.people) out.people = "matte" in aux.people ? { key: `m:${aux.people.matte}`, image: false } : still(aux.people.still);
  return out;
}

/** The frames/images a frame of the clip needs for its maps (add them to EditEngine.needs). */
export function auxNeeds(aux: ClipAux | undefined, frame: number): FrameKey[] {
  const seen = new Set<string>();
  const out: FrameKey[] = [];
  for (const r of Object.values(auxRefs(aux))) {
    const key = { stream: r.key, frame: r.image ? 0 : Math.max(0, frame) };
    const id = `${key.stream}#${key.frame}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(key);
    }
  }
  return out;
}

/**
 * The ClipAux of a document clip: `depth` (a DepthRef id; a stream when EditFiles has `d:<id>` as one, else a
 * still PNG under that key) and `matte` (it fills both "subject" and "people": one map). `files` are EditFiles' key sets.
 * Matte keys are `m:<id>` (a stream or an image).
 */
export function clipAuxOf(
  clip: { depth?: { id: string } | null; matte?: { id: string; mode?: string } | null },
  files: { streams: Record<string, unknown>; images: Record<string, unknown> },
): ClipAux {
  const aux: ClipAux = {};
  if (clip.depth?.id) {
    const key = `d:${clip.depth.id}`;
    if (key in files.streams) aux.depth = { stream: clip.depth.id };
    else if (key in files.images) aux.depth = { still: key };
  }
  if (clip.matte?.id) {
    const key = `m:${clip.matte.id}`;
    const ref = key in files.streams ? { matte: clip.matte.id } : key in files.images ? { still: key } : null;
    if (ref) {
      aux.subject = ref;
      aux.people = ref; // one map: "people" regions read the same matte as "subject"
    }
  }
  return aux;
}

/** Uploads map frames as textures, keeping the last few (a map changes slowly). */
export class AuxTextureCache {
  private readonly tex = new Map<FrameImage, AuxTex>();
  constructor(private readonly gl: WebGL2RenderingContext) {}

  texFor(image: FrameImage | null): AuxTex | null {
    if (!image || isClosed(image)) return null;
    const hit = this.tex.get(image);
    if (hit) return hit;
    const size = imageSize(image);
    if (size.w <= 0 || size.h <= 0) return null;
    const tex = this.gl.createTexture() as WebGLTexture;
    try {
      uploadFrameImage(this.gl, tex, image, false);
    } catch {
      this.gl.deleteTexture(tex);
      return null;
    }
    const entry: AuxTex = { tex };
    this.tex.set(image, entry);
    while (this.tex.size > 6) {
      const first = this.tex.keys().next().value as FrameImage;
      const old = this.tex.get(first);
      if (old) this.gl.deleteTexture(old.tex);
      this.tex.delete(first);
    }
    return entry;
  }

  dispose(): void {
    for (const t of this.tex.values()) this.gl.deleteTexture(t.tex);
    this.tex.clear();
  }
}

/** Resolves a clip's maps for output frame `frame` into a binding (maps whose frames aren't here yet stay constants). */
export function resolveAux(cache: AuxTextureCache, aux: ClipAux | undefined, frame: number, frames: FrameProvider, uv?: AuxBinding["uv"]): AuxBinding {
  const refs = auxRefs(aux);
  const get = (r: AuxRef | undefined): AuxTex | null => (r ? cache.texFor(r.image ? frames.image(r.key) : frames.frame({ stream: r.key, frame: Math.max(0, frame) })) : null);
  return { depth: get(refs.depth), subject: get(refs.subject), people: get(refs.people), uv };
}
