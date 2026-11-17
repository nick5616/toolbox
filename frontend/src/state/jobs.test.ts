import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, JobStatus, type Job } from "@/lib/api";
import { countJobs, flushProgress, normalizeJob, orderJobs, queueProgress, useJobs } from "./jobs";

function job(id: string, status: JobStatus, createdAt: number, finishedAt = 0): Job {
  return {
    id, moduleId: "downloader", title: id, status, progress: 0, message: "", inputs: null, optionsJson: "{}",
    errorCode: ErrorCode.$zero, error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt, startedAt: 0, finishedAt, outputs: null, resultJson: "", pipelineRunId: "", pipelineStepId: "",
  };
}

describe("jobs ordering", () => {
  it("puts active first (oldest first) then finished (latest first)", () => {
    const jobs = [
      job("d1", JobStatus.JobDone, 1, 10),
      job("q", JobStatus.JobQueued, 5),
      job("r", JobStatus.JobRunning, 3),
      job("f", JobStatus.JobFailed, 2, 20),
    ].map(normalizeJob);
    expect(orderJobs(jobs).map((j) => j.id)).toEqual(["r", "q", "f", "d1"]);
    expect(countJobs(jobs)).toMatchObject({ queued: 1, running: 1, done: 1, failed: 1, total: 4 });
  });

  it("normalizes null slices", () => {
    const j = normalizeJob(job("x", JobStatus.JobDone, 1));
    expect(j.inputs).toEqual([]);
    expect(j.outputs).toEqual([]);
  });
});

describe("progress batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useJobs.getState().setAll([job("a", JobStatus.JobRunning, 1), job("b", JobStatus.JobRunning, 2), job("c", JobStatus.JobDone, 3, 9)]);
  });
  afterEach(() => {
    flushProgress();
    vi.useRealTimers();
  });

  const p = (id: string, progress: number, message = "") => ({ id, progress, message });

  it("buffers events and applies them in one store update, latest wins per job", () => {
    let updates = 0;
    const off = useJobs.subscribe(() => updates++);
    queueProgress(p("a", 0.1));
    queueProgress(p("a", 0.4, "half"));
    queueProgress(p("b", 0.2));
    expect(updates).toBe(0);
    expect(useJobs.getState().byId["a"]!.progress).toBe(0);
    vi.advanceTimersByTime(300);
    off();
    expect(updates).toBe(1);
    expect(useJobs.getState().byId["a"]).toMatchObject({ progress: 0.4, message: "half" });
    expect(useJobs.getState().byId["b"]!.progress).toBe(0.2);
  });

  it("drops progress for finished or unknown jobs and keeps untouched jobs identical", () => {
    const before = useJobs.getState().byId;
    queueProgress(p("c", 0.5));
    queueProgress(p("zzz", 0.5));
    flushProgress();
    expect(useJobs.getState().byId).toBe(before);
  });

  it("a job that changed before the flush is not overwritten by older progress when flushed first", () => {
    queueProgress(p("a", 0.7));
    flushProgress(); // what the jobs:changed handler does first
    useJobs.getState().upsert(job("a", JobStatus.JobDone, 1, 10));
    vi.advanceTimersByTime(300);
    expect(useJobs.getState().byId["a"]!.status).toBe(JobStatus.JobDone);
    queueProgress(p("a", 0.9)); // late event for a finished job
    flushProgress();
    expect(useJobs.getState().byId["a"]!.progress).toBe(0); // the upserted state stands
  });

  it("keeps other jobs' references when one job ticks", () => {
    const b = useJobs.getState().byId["b"];
    queueProgress(p("a", 0.3));
    flushProgress();
    expect(useJobs.getState().byId["b"]).toBe(b);
  });
});
