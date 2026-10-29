import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, JobStatus, type Job, type MediaSource } from "@/lib/api";
import { useJobs } from "@/state/jobs";

const open = vi.fn<(path: string) => Promise<MediaSource>>();
vi.mock("@/lib/api", async (orig) => {
  const mod = await orig<typeof import("@/lib/api")>();
  return { ...mod, MediaService: { Open: (p: string) => open(p) } };
});

import { useMediaSource } from "./useMediaSource";

const info = { durationMs: 1000, startMs: 0, container: "mp4", sizeBytes: 1, bitRate: 0, video: null, audio: null, subtitles: null, hasCover: false, tags: null };
const src = (over: Partial<MediaSource>): MediaSource => ({ url: "", info, proxy: false, proxyJobId: "", ...over });

function job(id: string, status: JobStatus, progress = 0, extra: Partial<Job> = {}): Job {
  return {
    id, moduleId: "media-proxy", title: id, status, progress, message: "", inputs: null, optionsJson: "{}",
    errorCode: ErrorCode.$zero, error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt: 1, startedAt: 0, finishedAt: 0, outputs: null, resultJson: "", ...extra,
  };
}

beforeEach(() => {
  open.mockReset();
  useJobs.setState({ byId: {} });
});

describe("useMediaSource", () => {
  it("is idle without a path", () => {
    const { result } = renderHook(() => useMediaSource(null));
    expect(result.current.status).toBe("idle");
    expect(open).not.toHaveBeenCalled();
  });

  it("goes loading -> ready for a playable file", async () => {
    open.mockResolvedValue(src({ url: "/media/t/a.mp4" }));
    const { result } = renderHook(() => useMediaSource("C:/a.mp4"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source?.url).toBe("/media/t/a.mp4");
  });

  it("follows the preview-copy job, then re-opens", async () => {
    open.mockResolvedValueOnce(src({ proxyJobId: "j1" })).mockResolvedValueOnce(src({ url: "/media/t/p.mp4", proxy: true }));
    act(() => useJobs.getState().upsert(job("j1", JobStatus.JobRunning, 0.42)));
    const { result } = renderHook(() => useMediaSource("C:/a.mkv"));
    await waitFor(() => expect(result.current.status).toBe("preparing"));
    expect(result.current.progress).toBeCloseTo(0.42);
    expect(open).toHaveBeenCalledTimes(1);

    act(() => useJobs.getState().upsert(job("j1", JobStatus.JobDone, 1)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(open).toHaveBeenCalledTimes(2);
    expect(result.current.source?.proxy).toBe(true);
  });

  it("reports a failed preview job and retries", async () => {
    open.mockResolvedValueOnce(src({ proxyJobId: "j2" })).mockResolvedValueOnce(src({ url: "/media/t/p.mp4", proxy: true }));
    act(() => useJobs.getState().upsert(job("j2", JobStatus.JobRunning, 0.1)));
    const { result } = renderHook(() => useMediaSource("C:/a.mkv"));
    await waitFor(() => expect(result.current.status).toBe("preparing"));

    act(() => useJobs.getState().upsert(job("j2", JobStatus.JobFailed, 0.1, { error: "ffmpeg died", errorCode: ErrorCode.CodeInternal })));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("ffmpeg died");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("maps Open errors", async () => {
    open.mockRejectedValue({ cause: { code: "not_found", message: "gone" } });
    const { result } = renderHook(() => useMediaSource("C:/missing.mp4"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatchObject({ code: "not_found", message: "gone" });
  });

  it("returns to idle when the path is cleared", async () => {
    open.mockResolvedValue(src({ url: "/media/t/a.mp4" }));
    const { result, rerender } = renderHook(({ p }: { p: string | null }) => useMediaSource(p), { initialProps: { p: "C:/a.mp4" as string | null } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ p: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.source).toBeUndefined();
  });
});
