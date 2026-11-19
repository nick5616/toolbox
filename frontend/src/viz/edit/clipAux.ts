/**
 * Clip auxiliary maps (Phase 21 SPEC §E5): depth and subject maps that
 * effects can read. FROZEN contract after Wave 0; G1 implements `bindAux`
 * and the loaders, E4's clip renderer calls it before running a clip's
 * effects.
 *
 * - `EditFiles` keys: `d:<depthId>` is a depth edit stream (grey, near =
 *   white), `a:<path>` a still map PNG (depth or subject alpha).
 * - Passes that need a map declare `needs` in their PostDef; the clip renderer
 *   binds `u_depth` / `u_subject` (r channel 0..1, in the clip's source UV)
 *   and `u_hasDepth` / `u_hasSubject` (0/1).
 * - A missing map is a constant: depth 0.5, subject 1.
 */
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
