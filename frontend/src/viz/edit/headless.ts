/**
 * Headless requests of pipeline steps (Phase 14 A2), answered by the main
 * window's RenderHost with no tool open:
 *
 * - "composition": a Photo Composer document drawn by composer/render.ts on an
 *   OffscreenCanvas (the same function the editor and its export use), sent
 *   back as a PNG or JPEG;
 * - "recipe": an auto-fill recipe run on an edit (Cut to the beat), sent back
 *   as the filled project's JSON. Go then exports it with the normal edit
 *   render plan (viz/edit/worker.ts).
 *
 * The reply uses the render protocol (`vz1|<token>|…`), so the broker's token
 * and origin rules apply unchanged.
 */
import { fillWithRecipe, type RecipeRequest } from "@/editor/autofill/headless";
import type { Composition } from "@/lib/api";
import { renderCompositionBytes, type RenderedComposition } from "@/composer/export";
import { loadAnalysis, type Analysis, type AnalysisUrls } from "../analysis";
import { RenderError } from "../worker/transport";
import { SingleReply } from "./hostReply";

/** The plan Go writes for a headless request (core/viz.PlanForWorker). */
export interface SinglePlan {
  kind: "composition" | "recipe";
  width: number;
  height: number;
  analysis: { audioJsonUrl: string; featuresUrl: string; textJsonUrl: string };
  composition?: { documentJson: string; format: "png" | "jpg"; scale: number };
  recipe?: RecipeRequest;
}

/** What a request needs from the outside (replaced in tests). */
export interface SingleDeps {
  fetchPlan(url: string): Promise<SinglePlan>;
  renderComposition(doc: Composition, scale: number, opts: { format: "png" | "jpg"; signal: AbortSignal; onProgress: (f: number) => void }): Promise<RenderedComposition>;
  loadAnalysis(urls: AnalysisUrls): Promise<Analysis>;
}

export const defaultSingleDeps: SingleDeps = {
  async fetchPlan(url) {
    const res = await fetch(url);
    if (!res.ok) throw new RenderError("The render request couldn't be read", `HTTP ${res.status}`);
    return (await res.json()) as SinglePlan;
  },
  renderComposition: (doc, scale, opts) => renderCompositionBytes(doc, scale, opts),
  loadAnalysis: (urls) => loadAnalysis(urls),
};

/** One headless request in flight. */
export interface SingleRun {
  token: string;
  abort: AbortController;
}

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

function explain(e: unknown, fallback: string): { message: string; detail: string } {
  if (e instanceof RenderError) return { message: e.message, detail: e.detail };
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return { message: text.trim() ? text : fallback, detail: String(e) };
}

/** Answers one request. Never throws: failures go to Go as `error` messages. */
export async function runSingle(run: SingleRun, planUrl: string, invoke: (msg: string) => void, deps: SingleDeps = defaultSingleDeps): Promise<void> {
  const reply = new SingleReply(run.token, invoke);
  const signal = run.abort.signal;
  let fallback = "The render failed";
  try {
    const plan = await deps.fetchPlan(planUrl);
    if (signal.aborted) return reply.cancelled();
    if (plan.kind === "composition" && plan.composition) {
      fallback = "The picture couldn't be drawn";
      const c = plan.composition;
      // `start` first: Go's start timeout is short and loading photos is not.
      reply.start(c.format, plan.width, plan.height);
      let doc: Composition;
      try {
        doc = JSON.parse(c.documentJson) as Composition;
      } catch (e) {
        throw new RenderError("The composition couldn't be read", String(e));
      }
      const out = await deps.renderComposition(doc, c.scale > 0 ? c.scale : 1, {
        format: c.format,
        signal,
        onProgress: (f) => reply.progress(Math.round(f * 100), 100),
      });
      if (signal.aborted) return reply.cancelled();
      if (out.width !== plan.width || out.height !== plan.height) throw new RenderError("The picture has the wrong size", `${out.width}x${out.height}`);
      reply.file(out.bytes);
      return;
    }
    if (plan.kind === "recipe" && plan.recipe) {
      fallback = "The cuts couldn't be made";
      reply.start("json", 0, 0);
      const a = plan.analysis;
      if (!a.audioJsonUrl || !a.featuresUrl) throw new RenderError("The song's analysis is missing", "");
      const analysis = await deps.loadAnalysis({ audioJsonUrl: a.audioJsonUrl, featuresUrl: a.featuresUrl, textJsonUrl: a.textJsonUrl || undefined });
      if (signal.aborted) return reply.cancelled();
      const project = fillWithRecipe(plan.recipe, analysis);
      reply.file(new TextEncoder().encode(JSON.stringify(project)));
      return;
    }
    throw new RenderError("Unknown render request", plan.kind);
  } catch (e) {
    if (isAbort(e) || signal.aborted) return reply.cancelled();
    const { message, detail } = explain(e, fallback);
    reply.error(message, detail);
  }
}
