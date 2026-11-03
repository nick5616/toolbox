/**
 * The export worker (SPEC.md 7.2): renders a plan frame by frame with the
 * same Engine as the preview, encodes H.264 with WebCodecs (or MJPEG when no
 * encoder exists), and hands batches to the main thread, which forwards them
 * to Go. One worker per render; it also serves the VizLab parity check.
 */
import { fetchAll, loadAnalysis, type Analysis } from "../analysis";
import { Engine } from "../engine";
import { buildFixture } from "../fixture";
import { GLUnavailableError } from "../gl/core";
import { validateShow } from "../validate";
import type { PlanForWorker } from "../types";
import { runEdit } from "../edit/worker";
import { encodeFrames } from "./loop";
import { FlowControl, RenderError, type HostMessage, type ParityRequest, type WorkerMessage } from "./transport";

interface WorkerScope {
  postMessage(m: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<HostMessage>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (m: WorkerMessage, transfer?: Transferable[]) => scope.postMessage(m, transfer);

const flow = new FlowControl();
const io = { post, flow };

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const bytes = await fetchAll(url);
    return await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return null; // a texture that fails to load is skipped
  }
}

function makeEngine(canvas: OffscreenCanvas, opts: ConstructorParameters<typeof Engine>[1]): Engine {
  try {
    return new Engine(canvas, opts);
  } catch (e) {
    if (e instanceof GLUnavailableError) throw new RenderError(e.message, e.gpu);
    throw e;
  }
}

async function run(planUrl: string, forceJpeg: boolean): Promise<void> {
  let plan: PlanForWorker;
  try {
    plan = JSON.parse(new TextDecoder().decode(await fetchAll(planUrl))) as PlanForWorker;
  } catch (e) {
    throw new RenderError("The visual renderer couldn't read its instructions", String(e));
  }
  if (plan.kind === "edit") return runEdit(plan, forceJpeg, io); // Edit Studio (Phase 9 §12.2)
  const v = validateShow(plan.showJson);
  if (!v.ok) throw new RenderError("This design couldn't be read", v.problem);
  const analysis = await loadAnalysis({ audioJsonUrl: plan.analysis.audioJsonUrl, featuresUrl: plan.analysis.featuresUrl, textJsonUrl: plan.analysis.textJsonUrl || undefined });
  if (flow.cancelled) return void post({ type: "cancelled" });

  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const engine = makeEngine(canvas, { width: plan.width, height: plan.height, mode: plan.mode, quality: "full", seed: plan.seed, fps: plan.fps, inWorker: true });
  try {
    engine.setAnalysis(analysis);
    engine.setShow(v.show);
    engine.setTextures({ cover: await loadBitmap(plan.coverUrl), image: await loadBitmap(plan.imageUrl) });
    if (flow.cancelled) return void post({ type: "cancelled" });

    const endMs = plan.endMs > plan.startMs ? plan.endMs : analysis.durationMs;
    const frames = Math.max(1, Math.round(((endMs - plan.startMs) / 1000) * plan.fps));
    await encodeFrames(canvas, { fps: plan.fps, frames, overlay: plan.mode === "overlay", forceJpeg }, (i) => engine.render(plan.startMs + (i * 1000) / plan.fps), io);
  } finally {
    engine.dispose();
  }
}

/** VizLab parity (SPEC.md 11.4): render the sampled times and return the raw pixels; no encoding. */
async function parity(req: ParityRequest): Promise<void> {
  const v = validateShow(req.showJson);
  if (!v.ok) throw new RenderError("This design couldn't be read", v.problem);
  const analysis: Analysis = req.analysis
    ? await loadAnalysis({ audioJsonUrl: req.analysis.audioJsonUrl, featuresUrl: req.analysis.featuresUrl, textJsonUrl: req.analysis.textJsonUrl || undefined })
    : buildFixture({ durationMs: req.fixtureMs });
  const canvas = new OffscreenCanvas(req.width, req.height);
  const engine = makeEngine(canvas, { width: req.width, height: req.height, mode: "opaque", quality: "full", seed: req.seed, fps: req.fps, inWorker: true });
  try {
    engine.setAnalysis(analysis);
    engine.setShow(v.show);
    const out: ArrayBuffer[] = [];
    for (const t of req.timesMs) {
      engine.render(t);
      out.push(engine.readPixels().buffer as ArrayBuffer);
    }
    post({ type: "parity-result", frames: out }, out);
  } finally {
    engine.dispose();
  }
}

function fail(err: unknown): void {
  if (err instanceof RenderError) post({ type: "error", message: err.message, detail: err.detail });
  else if (err instanceof GLUnavailableError) post({ type: "error", message: err.message, detail: err.gpu });
  else post({ type: "error", message: "The visual renderer failed", detail: err instanceof Error ? err.message : String(err) });
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "cancel") flow.cancel();
  else if (m.type === "ack") flow.ack(m.bytes);
  else if (m.type === "render") run(m.planUrl, m.forceJpeg === true).catch(fail);
  else if (m.type === "parity") parity(m.req).catch(fail);
};
