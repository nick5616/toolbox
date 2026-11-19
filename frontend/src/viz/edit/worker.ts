/**
 * Edit Studio export renders inside the export worker (Phase 9 SPEC §12.2).
 *
 * Loads the analysis and the project, derives the markers, compiles the edit,
 * builds an exact FrameProvider on the export URLs, then per frame i:
 * t = i·1000/fps, await prepare(needs(t)), render(t), encode. The same
 * EditEngine as the preview draws the frame, so the export matches it.
 */
import { applyGradePlan, type GradePlanJson } from "@/grade/plan";
import { loadAnalysis, type Analysis } from "../analysis";
import { AuxTextureCache, auxNeeds, bindAux, resolveAux, type ClipAux } from "./clipAux";
import { EditFrameProvider } from "../frames/provider";
import { GLUnavailableError } from "../gl/core";
import type { PlanForWorker } from "../types";
import { encodeFrames, type LoopIO } from "../worker/loop";
import { RenderError } from "../worker/transport";
import { compileEdit } from "./compile";
import { normalizeProject } from "./defaults";
import { EditEngine } from "./engine";
import { emptyAnalysis } from "./emptyAnalysis";
import { deriveMarkers } from "./markers";
import type { EditProject } from "./types";

export function parseProject(json: string): EditProject {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new RenderError("The edit couldn't be read", String(e));
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { tracks?: unknown }).tracks)) throw new RenderError("The edit couldn't be read", "no tracks");
  return normalizeProject(raw as EditProject);
}

export async function runEdit(plan: PlanForWorker, forceJpeg: boolean, io: LoopIO): Promise<void> {
  const edit = plan.edit;
  if (!edit) throw new RenderError("The edit couldn't be read", "the render plan has no edit");
  let project = parseProject(edit.projectJson);
  // Phase 21 (§E3.5): a Color Grader render carries its look in the plan; compile it onto the first picture clip.
  let aux: ClipAux = {};
  const grade = (plan as PlanForWorker & { grade?: GradePlanJson }).grade;
  if (grade) {
    try {
      const applied = applyGradePlan(project, grade, { streams: edit.streams, images: edit.images });
      project = applied.project as typeof project;
      aux = applied.aux;
    } catch (e) {
      throw new RenderError("The look couldn't be applied", e instanceof Error ? e.message : String(e));
    }
  }
  // No analysis (a Video Editor project) renders against an empty one: curves read 0, no markers.
  const hasAnalysis = Boolean(plan.analysis.audioJsonUrl && plan.analysis.featuresUrl);
  const analysis: Analysis = hasAnalysis
    ? await loadAnalysis({ audioJsonUrl: plan.analysis.audioJsonUrl, featuresUrl: plan.analysis.featuresUrl, textJsonUrl: plan.analysis.textJsonUrl || undefined })
    : emptyAnalysis();
  if (io.flow.cancelled) return void io.post({ type: "cancelled" });

  const markers = hasAnalysis && project.song ? deriveMarkers(analysis, project.markers, { startMs: project.song.startMs, endMs: project.song.endMs }) : [];
  const provider = new EditFrameProvider({ files: { streams: edit.streams, images: edit.images }, mode: "export" });
  let engine: EditEngine | null = null;
  let auxCache: AuxTextureCache | null = null;
  try {
    // Stream lengths first, so clips hold their last frame exactly.
    const streamFrames = await provider.loadIndexes(Object.keys(edit.streams));
    const compiled = compileEdit({ project, analysis, markers, files: { streams: edit.streams, images: edit.images } }, { width: plan.width, height: plan.height, fps: plan.fps, streamFrames });
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    try {
      engine = new EditEngine(canvas, { width: plan.width, height: plan.height, fps: plan.fps, seed: project.seed, quality: "full", inWorker: true });
    } catch (e) {
      if (e instanceof GLUnavailableError) throw new RenderError(e.message, e.gpu);
      throw e;
    }
    engine.setEdit(compiled);
    const eng = engine;
    if (io.flow.cancelled) return void io.post({ type: "cancelled" });
    // The graded clip's depth/subject maps (bound for the whole one-clip frame, see viz/edit/clipAux.ts).
    const hasAux = Object.keys(aux).length > 0;
    const gl = hasAux ? (canvas.getContext("webgl2") as WebGL2RenderingContext | null) : null;
    if (gl) auxCache = new AuxTextureCache(gl);
    await encodeFrames(
      canvas,
      { fps: plan.fps, frames: Math.max(1, Math.round(((compiled.durationMs) / 1000) * plan.fps)), overlay: false, forceJpeg },
      async (i) => {
        const t = (i * 1000) / plan.fps;
        await provider.prepare([...eng.needs(t), ...(gl ? auxNeeds(aux, i) : [])], true);
        if (gl && auxCache) bindAux(gl, resolveAux(auxCache, aux, i, provider));
        eng.render(t, provider);
      },
      io,
    );
  } finally {
    auxCache?.dispose();
    engine?.dispose();
    provider.dispose();
  }
}
