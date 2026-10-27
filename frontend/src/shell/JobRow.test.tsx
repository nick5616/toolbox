import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, JobStatus, OutputKind, JobsService, type Job } from "@/lib/api";
import { normalizeJob, useJobs } from "@/state/jobs";
import { JobRow } from "./JobRow";

function mk(status: JobStatus, extra: Partial<Job> = {}) {
  return normalizeJob({
    id: "j1", moduleId: "downloader", title: "My video", status, progress: 0.5, message: "", inputs: null,
    optionsJson: "{}", errorCode: ErrorCode.$zero, error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt: 1, startedAt: 1, finishedAt: 0, outputs: null, ...extra,
  });
}

const output = {
  id: "o1", jobId: "j1", moduleId: "downloader", path: "/x/a.mp3", name: "a.mp3",
  kind: OutputKind.KindAudio, sizeBytes: 1, createdAt: 1, tags: null, missing: false,
};

describe("JobRow", () => {
  beforeEach(() => {
    useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  });

  it("shows Cancel for queued and running jobs", () => {
    for (const s of [JobStatus.JobQueued, JobStatus.JobRunning]) {
      const { unmount } = render(<JobRow job={mk(s)} />);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      unmount();
    }
  });

  it("shows Retry for failed and cancelled jobs", () => {
    for (const s of [JobStatus.JobFailed, JobStatus.JobCancelled]) {
      const { unmount } = render(<JobRow job={mk(s, { finishedAt: 5 })} />);
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      unmount();
    }
  });

  it("shows error and hint for failed jobs", () => {
    render(<JobRow job={mk(JobStatus.JobFailed, { error: "boom", errorHint: "try again", finishedAt: 5 })} />);
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("try again")).toBeTruthy();
  });

  it("shows Reveal for done jobs with outputs only", () => {
    const { unmount } = render(<JobRow job={mk(JobStatus.JobDone, { outputs: [output], finishedAt: 5 })} />);
    expect(screen.getByRole("button", { name: /Reveal in Finder|Show in Explorer/ })).toBeTruthy();
    unmount();
    render(<JobRow job={mk(JobStatus.JobDone, { finishedAt: 5 })} />);
    expect(screen.queryByRole("button", { name: /Reveal in Finder|Show in Explorer/ })).toBeNull();
  });

  it("shows Cancelling… while cancel is requested", () => {
    render(<JobRow job={mk(JobStatus.JobRunning, { cancelRequested: true, message: "x" })} />);
    expect(screen.getByText("Cancelling…")).toBeTruthy();
  });

  it("compact hides remove and log toggle", () => {
    render(<JobRow compact job={mk(JobStatus.JobDone, { finishedAt: 5 })} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: /log/i })).toBeNull();
  });

  it("full row has remove and log toggle for finished jobs", () => {
    render(<JobRow job={mk(JobStatus.JobDone, { finishedAt: 5 })} />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show log" })).toBeTruthy();
  });

  it("clicking Cancel calls the store action", () => {
    const spy = vi.spyOn(JobsService, "Cancel").mockResolvedValue(undefined as never);
    render(<JobRow job={mk(JobStatus.JobRunning)} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(spy).toHaveBeenCalledWith("j1");
  });
});
