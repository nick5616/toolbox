/**
 * compileEdit (Phase 9 SPEC §8.3). WP-ES3 implements it; the signature is
 * frozen. The Wave 0 stub only lists each track's clips by time so the stub
 * engine can draw placeholder colours.
 */
import { normalizeProject } from "./defaults";
import type { CompiledEdit, EditInputs } from "./types";
import { editLength } from "./types";

/** Wave 0 stub data (WP-ES3 replaces it with its own fields). */
export interface StubCompiled extends CompiledEdit {
  tracks: Array<{ muted: boolean; clips: Array<{ id: string; kind: string; color: string; startMs: number; endMs: number }> }>;
  background: string;
}

export function compileEdit(inputs: EditInputs, opts: { width: number; height: number; fps: number }): CompiledEdit {
  const p = normalizeProject(inputs.project);
  const durationMs = editLength(p);
  const c: StubCompiled = {
    durationMs,
    fps: opts.fps,
    frames: Math.max(1, Math.round((durationMs / 1000) * opts.fps)),
    problems: [],
    background: p.background,
    tracks: p.tracks.map((t) => ({ muted: t.muted, clips: t.clips.map((cl) => ({ id: cl.id, kind: cl.kind, color: cl.color, startMs: cl.startMs, endMs: cl.endMs })) })),
  };
  return c;
}
