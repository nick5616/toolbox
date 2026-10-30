/**
 * VizLab parity check (SPEC.md 11.4): the same frames through the export
 * worker path (Engine on an OffscreenCanvas in a worker) and the preview path
 * (Engine on a DOM canvas). Passes when the mean absolute difference is at
 * most 1/255 per channel.
 */
import { Engine } from "../engine";
import { showFromPreset, type Preset } from "../presets";
import type { Analysis } from "../analysis";
import type { HostMessage, ParityRequest, WorkerMessage } from "../worker/transport";

export const PARITY_TOLERANCE = 1 / 255;

export interface ParityFrame {
  preset: string;
  timeMs: number;
  meanAbsDiff: number; // 0..1
  maxDiff: number; // 0..255
}

export interface ParityReport {
  ok: boolean;
  tolerance: number;
  worstMeanAbsDiff: number;
  width: number;
  height: number;
  gpu: string;
  frames: ParityFrame[];
}

/** Mean absolute per-channel difference (0..1) and the largest single difference (0..255). */
export function compareFrames(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  const n = Math.min(a.length, b.length);
  if (a.length !== b.length) return { mean: 1, max: 255 };
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    sum += d;
    if (d > max) max = d;
  }
  return { mean: n ? sum / n / 255 : 0, max };
}

function workerFrames(req: ParityRequest): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../worker/render.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "parity-result") {
        worker.terminate();
        resolve(m.frames.map((b) => new Uint8Array(b)));
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(`${m.message}: ${m.detail}`));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ type: "parity", req } satisfies HostMessage);
  });
}

export async function runParity(opts: {
  presets: Preset[];
  analysis: Analysis;
  analysisUrls: ParityRequest["analysis"];
  fixtureMs: number;
  canvas: HTMLCanvasElement;
  timesFor: (a: Analysis) => number[];
  say: (s: string) => void;
}): Promise<ParityReport> {
  const width = 960;
  const height = 540;
  const times = opts.timesFor(opts.analysis);
  const frames: ParityFrame[] = [];
  let gpu = "";
  for (const p of opts.presets) {
    const show = showFromPreset(p);
    const showJson = JSON.stringify(show);
    const req: ParityRequest = { showJson, analysis: opts.analysisUrls, fixtureMs: opts.fixtureMs, width, height, seed: 1, fps: 30, timesMs: times };
    const fromWorker = await workerFrames(req);
    const engine = new Engine(opts.canvas, { width, height, mode: "opaque", quality: "full", seed: 1, fps: 30, inWorker: false });
    gpu = engine.gpu;
    engine.setAnalysis(opts.analysis);
    engine.setShow(show);
    times.forEach((t, i) => {
      engine.render(t);
      const c = compareFrames(engine.readPixels(), fromWorker[i] ?? new Uint8Array());
      frames.push({ preset: p.id, timeMs: Math.round(t), meanAbsDiff: Math.round(c.mean * 1e6) / 1e6, maxDiff: c.max });
    });
    engine.dispose();
    opts.say(`parity ${p.id}: worst ${Math.max(...frames.filter((f) => f.preset === p.id).map((f) => f.meanAbsDiff)).toFixed(5)}`);
  }
  const worst = Math.max(0, ...frames.map((f) => f.meanAbsDiff));
  return { ok: worst <= PARITY_TOLERANCE, tolerance: PARITY_TOLERANCE, worstMeanAbsDiff: worst, width, height, gpu, frames };
}
