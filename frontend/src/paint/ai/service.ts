// The real wiring of AIDeps: PaintService + JobsService + the job store + a
// canvas PNG codec. Only this file (and gates.ts) touches the bindings.

import { JobsService, PaintService, type PaintAIRequest } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import type { AIDeps, ImageCodec, JobLike, JobStatusName } from "./deps";
import { createImage } from "./pixels";

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function put(img: ImageData): HTMLCanvasElement {
  const c = makeCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas available");
  ctx.putImageData(img, 0, 0);
  return c;
}

export const browserCodec: ImageCodec = {
  async encode(img) {
    return put(img).toDataURL("image/png");
  },
  async decode(url) {
    const el = new Image();
    el.src = url;
    await el.decode();
    const c = makeCanvas(el.naturalWidth, el.naturalHeight);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No 2D canvas available");
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return createImage(d.width, d.height, d.data);
  },
  async thumb(img, max) {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const src = put(img);
    const c = makeCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  },
};

export function defaultAIDeps(): AIDeps {
  return {
    submit: (projectId, req: PaintAIRequest) => PaintService.AI(projectId, req),
    result: (jobId, index) => PaintService.AIResult(jobId, index),
    cancelJob: (jobId) => JobsService.Cancel(jobId),
    job: (jobId): JobLike | undefined => {
      const j = useJobs.getState().byId[jobId];
      if (!j) return undefined;
      return { status: j.status as JobStatusName, progress: j.progress, message: j.message, error: j.error };
    },
    subscribeJobs: (cb) => useJobs.subscribe(cb),
    codec: browserCodec,
  };
}
