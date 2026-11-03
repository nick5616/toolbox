/**
 * The encode loop shared by show renders and Edit Studio renders (Phase 9
 * SPEC §12.2): pick an encoder, render frame i, encode it (H.264 or JPEG),
 * batch and post the bytes with back-pressure, report progress.
 */
import { chooseEncoder } from "./encoder";
import { Batcher, RenderError, type FlowControl, type WorkerMessage } from "./transport";

const MAX_ENCODE_QUEUE = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LoopIO {
  post(m: WorkerMessage, transfer?: Transferable[]): void;
  flow: FlowControl;
}

export interface LoopOptions {
  fps: number;
  frames: number;
  /** Overlay renders stack colour over alpha (double-height canvas). */
  overlay: boolean;
  forceJpeg: boolean;
}

/**
 * Renders `frames` frames with renderFrame(i) into canvas and streams them.
 * Posts start/data/progress/done, or "cancelled" when flow is cancelled.
 */
export async function encodeFrames(canvas: OffscreenCanvas, o: LoopOptions, renderFrame: (i: number) => void | Promise<void>, io: LoopIO): Promise<void> {
  const { flow, post } = io;
  const choice = await chooseEncoder(canvas.width, canvas.height, o.fps, o.overlay, o.forceJpeg);
  post({ type: "start", info: { encoder: choice.label, width: canvas.width, height: canvas.height, fps: o.fps, frames: o.frames } });

  const batcher = new Batcher((buf) => {
    const copy = buf.slice();
    flow.addSent(copy.length);
    post({ type: "data", buf: copy.buffer }, [copy.buffer]);
  });
  let enc: VideoEncoder | null = null;
  let encErr: string | null = null;
  try {
    if (choice.kind === "h264") {
      enc = new VideoEncoder({
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
    }

    for (let i = 0; i < o.frames; i++) {
      if (flow.cancelled) return void post({ type: "cancelled" });
      if (encErr) throw new RenderError("Video encoding failed", encErr);
      await renderFrame(i);
      if (enc) {
        const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
        enc.encode(vf, { keyFrame: i % (2 * o.fps) === 0 });
        vf.close();
        while (enc.encodeQueueSize > MAX_ENCODE_QUEUE && !flow.cancelled && !encErr) {
          await Promise.race([new Promise<void>((r) => enc?.addEventListener("dequeue", () => r(), { once: true })), sleep(50)]);
        }
      } else {
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
        batcher.push(new Uint8Array(await blob.arrayBuffer()));
      }
      await flow.waitWindow();
      if (i % 15 === 0) post({ type: "progress", frame: i, frames: o.frames });
    }
    if (flow.cancelled) return void post({ type: "cancelled" });
    if (enc) {
      await enc.flush();
      if (encErr) throw new RenderError("Video encoding failed", encErr);
    }
    batcher.flush();
    post({ type: "progress", frame: o.frames, frames: o.frames });
    post({ type: "done", frames: o.frames, bytes: flow.sent });
  } finally {
    if (enc && enc.state !== "closed") enc.close();
  }
}
