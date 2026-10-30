/**
 * The export worker (SPEC.md §7.2): renders a plan frame by frame with the
 * same Engine as the preview, encodes H.264 with WebCodecs, and hands batches
 * to the main thread, which forwards them to Go.
 *
 * CONTRACT SKELETON (foundation): message protocol and the H.264 path are
 * here; RH1 adds the JPEG fallback, the ack back-pressure and cancel polish.
 */
import { fetchAll, loadAnalysis } from "../analysis";
import { Engine } from "../engine";
import { validateShow } from "../validate";
import type { PlanForWorker } from "../types";
import { chooseEncoder } from "./encoder";
import { Batcher, MAX_IN_FLIGHT, type HostMessage, type WorkerMessage } from "./transport";

interface WorkerScope {
  postMessage(m: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<HostMessage>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (m: WorkerMessage, transfer?: Transferable[]) => scope.postMessage(m, transfer);

let cancelled = false;
let acked = 0;
let sent = 0;
const ackWaiters: Array<() => void> = [];

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const bytes = await fetchAll(url);
    return await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return null;
  }
}

async function run(planUrl: string): Promise<void> {
  const plan = JSON.parse(new TextDecoder().decode(await fetchAll(planUrl))) as PlanForWorker;
  const v = validateShow(plan.showJson);
  if (!v.ok) throw new Error(`This design couldn't be read|${v.problem}`);
  const analysis = await loadAnalysis({ audioJsonUrl: plan.analysis.audioJsonUrl, featuresUrl: plan.analysis.featuresUrl, textJsonUrl: plan.analysis.textJsonUrl || undefined });
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const engine = new Engine(canvas, { width: plan.width, height: plan.height, mode: plan.mode, quality: "full", seed: plan.seed, fps: plan.fps, inWorker: true });
  engine.setAnalysis(analysis);
  engine.setShow(v.show);
  engine.setTextures({ cover: await loadBitmap(plan.coverUrl), image: await loadBitmap(plan.imageUrl) });

  const endMs = plan.endMs > plan.startMs ? plan.endMs : analysis.durationMs;
  const frames = Math.max(1, Math.round(((endMs - plan.startMs) / 1000) * plan.fps));
  const choice = await chooseEncoder(canvas.width, canvas.height, plan.fps, plan.mode === "overlay");
  if (choice.kind === "jpeg") throw new Error("This computer can't encode video in the window|JPEG fallback not built yet");
  post({ type: "start", info: { encoder: choice.label, width: canvas.width, height: canvas.height, fps: plan.fps, frames } });

  const batcher = new Batcher((buf) => {
    const copy = buf.slice();
    sent += copy.length;
    post({ type: "data", buf: copy.buffer }, [copy.buffer]);
  });
  let encErr: string | null = null;
  const enc = new VideoEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      batcher.push(b);
    },
    error: (e) => {
      encErr = e.message;
    },
  });
  enc.configure(choice.config);
  for (let i = 0; i < frames; i++) {
    if (cancelled) {
      enc.close();
      post({ type: "cancelled" });
      return;
    }
    if (encErr) throw new Error(`Video encoding failed|${encErr}`);
    engine.render(plan.startMs + (i * 1000) / plan.fps);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / plan.fps), duration: Math.round(1e6 / plan.fps) });
    enc.encode(vf, { keyFrame: i % (2 * plan.fps) === 0 });
    vf.close();
    while (enc.encodeQueueSize > 6) await new Promise<void>((r) => enc.addEventListener("dequeue", () => r(), { once: true }));
    while (sent - acked > MAX_IN_FLIGHT && !cancelled) await new Promise<void>((r) => ackWaiters.push(r));
    if (i % 15 === 0) post({ type: "progress", frame: i, frames });
  }
  await enc.flush();
  enc.close();
  batcher.flush();
  engine.dispose();
  post({ type: "progress", frame: frames, frames });
  post({ type: "done", frames, bytes: sent });
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "cancel") {
    cancelled = true;
    for (const w of ackWaiters.splice(0)) w();
  } else if (m.type === "ack") {
    acked = Math.max(acked, m.bytes);
    for (const w of ackWaiters.splice(0)) w();
  } else if (m.type === "render") {
    run(m.planUrl).catch((err: unknown) => {
      const [message, detail] = String(err instanceof Error ? err.message : err).split("|");
      post({ type: "error", message: message ?? "The visual renderer failed", detail: detail ?? "" });
    });
  }
};
