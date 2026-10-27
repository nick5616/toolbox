import { describe, expect, it } from "vitest";
import { ErrorCode, JobStatus, type Job } from "@/lib/api";
import { countJobs, normalizeJob, orderJobs } from "./jobs";

function job(id: string, status: JobStatus, createdAt: number, finishedAt = 0): Job {
  return {
    id, moduleId: "downloader", title: id, status, progress: 0, message: "", inputs: null, optionsJson: "{}",
    errorCode: ErrorCode.$zero, error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt, startedAt: 0, finishedAt, outputs: null, resultJson: "",
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
