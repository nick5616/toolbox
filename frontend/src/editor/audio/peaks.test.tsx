import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/wholeFile", () => ({ wholeFileBytes: (...a: unknown[]) => h.read(...a) }));

import type { EditSourceState } from "@/lib/api";
import { useEditStudio } from "@/editor/store";
import { clearPeaksCache, loadPeaks, parsePeaks, usePeaks } from "./peaks";

function peaksBin(pairs: Array<[number, number]>): Uint8Array {
  const head = new TextEncoder().encode(`${JSON.stringify({ v: 1, rate: 100, channels: 1 })}\n`);
  const out = new Uint8Array(head.length + pairs.length * 2);
  out.set(head);
  const body = new Int8Array(out.buffer, head.length, pairs.length * 2);
  pairs.forEach(([lo, hi], i) => {
    body[2 * i] = lo;
    body[2 * i + 1] = hi;
  });
  return out;
}

const source = (path: string, peaks: string): EditSourceState => ({ path, peaks, info: { path } as EditSourceState["info"], preview: null, image: "", shots: null, preparing: false, error: "" });

beforeEach(() => {
  clearPeaksCache();
  h.read.mockReset();
  useEditStudio.getState().close();
  useEditStudio.setState({ sources: {} });
});

describe("parsePeaks", () => {
  it("reads the header and the min/max pairs", () => {
    const p = parsePeaks(peaksBin([[-10, 20], [-5, 5], [0, 127]]));
    expect(p?.rate).toBe(100);
    expect(p?.durationMs).toBeCloseTo(30);
    expect(Array.from(p?.min ?? [])).toEqual([-10, -5, 0]);
    expect(Array.from(p?.max ?? [])).toEqual([20, 5, 127]);
  });
  it("refuses a file without a header", () => {
    expect(parsePeaks(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("usePeaks", () => {
  it("is null without peaks, then loads the file once and shares it", async () => {
    h.read.mockResolvedValue(peaksBin([[-1, 1], [-2, 2]]));
    const { result, rerender } = renderHook(({ path }) => usePeaks(path), { initialProps: { path: "/a.mp4" as string | null } });
    expect(result.current).toBeNull();
    useEditStudio.getState().setSources([source("/a.mp4", "/cache/a/peaks.bin")]);
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.max[1]).toBe(2);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith("/cache/a/peaks.bin");
    // a second user of the same file gets it from the cache, no second read
    const second = renderHook(() => usePeaks("/a.mp4"));
    expect(second.result.current?.max[1]).toBe(2);
    expect(h.read).toHaveBeenCalledTimes(1);
    rerender({ path: null });
    expect(result.current).toBeNull();
  });

  it("a file that can't be read stays null", async () => {
    h.read.mockRejectedValue(new Error("gone"));
    expect(await loadPeaks("/x/peaks.bin")).toBeNull();
    useEditStudio.getState().setSources([source("/b.mp4", "/x/peaks.bin")]);
    const { result } = renderHook(() => usePeaks("/b.mp4"));
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });
});
