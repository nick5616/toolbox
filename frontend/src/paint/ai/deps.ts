// What the perception queue needs from the outside world, as an interface so
// tests inject fakes. `defaultAIDeps()` wires the real bindings (service.ts).

import type { PaintAIRequest } from "@/lib/api";

export type JobStatusName = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobLike {
  status: JobStatusName;
  progress: number;
  message: string;
  error: string;
}

export interface ImageCodec {
  /** PNG data URL of the pixels (straight alpha). */
  encode(img: ImageData): Promise<string>;
  decode(dataURL: string): Promise<ImageData>;
  /** Small preview, longest side ≤ max, as a data URL. */
  thumb(img: ImageData, max: number): Promise<string>;
}

export interface AIDeps {
  /** PaintService.AI: submits the job. */
  submit(projectId: string, req: PaintAIRequest): Promise<{ id: string }>;
  /** PaintService.AIResult: PNG data URL of result `index` (read once). */
  result(jobId: string, index: number): Promise<string>;
  /** JobsService.Cancel. */
  cancelJob(jobId: string): Promise<void>;
  /** The job store (state/jobs.ts). */
  job(jobId: string): JobLike | undefined;
  subscribeJobs(cb: () => void): () => void;
  codec: ImageCodec;
}
