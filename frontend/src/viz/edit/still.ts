/**
 * One full-resolution frame of an edit (Phase 21 SPEC §E3.5): the headless "still" request. The render host
 * draws it with the same EditEngine as the preview and the export worker (export tier streams, exact decode)
 * on an OffscreenCanvas at width × height (≤ 8192 on the long side, and ≤ what this GPU allows), applies the
 * plan's Color Grader look with `compileRecipe` (grade/plan.ts), and encodes PNG, JPEG or WebP. Used by Color
 * Grader pictures, the Video Editor's "Still frame" and the pipeline step.
 */
import { applyGradePlan, type GradePlanJson } from "@/grade/plan";
import { loadAnalysis, type Analysis } from "../analysis";
import { EditFrameProvider } from "../frames/provider";
import { GLUnavailableError } from "../gl/core";
import { RenderError } from "../worker/transport";
import { compileEdit } from "./compile";
import { EditEngine } from "./engine";
import { emptyAnalysis } from "./emptyAnalysis";
import type { SingleReply } from "./hostReply";
import { parseProject } from "./worker";

/** The longest side a still may have. */
export const MAX_STILL_SIDE = 8192;

export interface StillRequest {
  width: number;
  height: number;
  analysis: { audioJsonUrl: string; featuresUrl: string; textJsonUrl: string };
  edit: { projectJson: string; streams: Record<string, { url: string; indexUrl: string }>; images: Record<string, string> };
  still: { atMs: number; format: "png" | "jpg" | "webp"; quality: number };
  grade?: GradePlanJson;
}

/** A user-facing message when the size can't be drawn, else null. `maxTexture` is the GPU's limit (Infinity = unknown). */
export function stillSizeProblem(width: number, height: number, maxTexture = Infinity): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return "The picture has no size";
  const long = Math.max(width, height);
  if (long > MAX_STILL_SIDE) return `A picture can be at most ${MAX_STILL_SIDE} px on its long side (this one is ${long})`;
  if (long > maxTexture) return `This computer's graphics can draw pictures up to ${maxTexture} px on the long side (this one is ${long})`;
  return null;
}

export const stillMime = (format: StillRequest["still"]["format"]): string => (format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg");

/** The JPEG/WebP quality for convertToBlob (0..1); 0 or out of range = 92. */
export function stillQuality(q: number): number {
  return q >= 1 && q <= 100 ? q / 100 : 0.92;
}

function gpuLimit(): number {
  const probe = new OffscreenCanvas(1, 1);
  const gl = probe.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) throw new RenderError("This computer's graphics can't draw pictures", "no WebGL2");
  const lim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return lim;
}

export async function renderStill(req: StillRequest, reply: SingleReply, signal: AbortSignal, deps: { loadAnalysis?: typeof loadAnalysis } = {}): Promise<void> {
  const problem = stillSizeProblem(req.width, req.height, gpuLimit());
  if (problem) throw new RenderError(problem, `${req.width}x${req.height}`);
  // `start` first: Go's start timeout is short and decoding is not.
  reply.start(req.still.format, req.width, req.height);

  let project = parseProject(req.edit.projectJson);
  const files = { streams: req.edit.streams, images: req.edit.images };
  if (req.grade) {
    try {
      const applied = applyGradePlan(project, req.grade, files);
      project = applied.project as typeof project;
    } catch (e) {
      throw new RenderError("The look couldn't be applied", e instanceof Error ? e.message : String(e));
    }
  }
  const a = req.analysis;
  const load = deps.loadAnalysis ?? loadAnalysis;
  const analysis: Analysis = a.audioJsonUrl && a.featuresUrl ? await load({ audioJsonUrl: a.audioJsonUrl, featuresUrl: a.featuresUrl, textJsonUrl: a.textJsonUrl || undefined }) : emptyAnalysis();
  if (signal.aborted) return reply.cancelled();

  const fps = project.fps > 0 ? project.fps : 30;
  const provider = new EditFrameProvider({ files, mode: "export" });
  let engine: EditEngine | null = null;
  try {
    const streamFrames = await provider.loadIndexes(Object.keys(files.streams));
    const compiled = compileEdit({ project, analysis, markers: [], files }, { width: req.width, height: req.height, fps, streamFrames });
    const canvas = new OffscreenCanvas(req.width, req.height);
    try {
      engine = new EditEngine(canvas, { width: req.width, height: req.height, fps, seed: project.seed, quality: "full", inWorker: true });
    } catch (e) {
      if (e instanceof GLUnavailableError) throw new RenderError(e.message, e.gpu);
      throw e;
    }
    engine.setEdit(compiled);
    const at = Math.max(0, req.still.atMs);
    reply.progress(0, 2);
    await provider.prepare(engine.needs(at), true, signal);
    if (signal.aborted) return reply.cancelled();
    engine.render(at, provider);
    // Snapshot the canvas now: convertToBlob copies it at the call, before the buffer can be cleared.
    const blob = await canvas.convertToBlob({ type: stillMime(req.still.format), quality: stillQuality(req.still.quality) });
    if (signal.aborted) return reply.cancelled();
    if (blob.type !== stillMime(req.still.format)) throw new RenderError("This computer can't save the picture in that format", blob.type || "unknown type");
    reply.progress(1, 2);
    reply.file(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    engine?.dispose();
    provider.dispose();
  }
}
