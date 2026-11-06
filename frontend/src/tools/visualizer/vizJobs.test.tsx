import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, VisualizerService: { Enqueue: (...a: unknown[]) => enqueue(...a) }, JobsService: { Cancel: async () => undefined } };
});

import type { VisualizerOptions } from "@/lib/api";
import { takeAnnounced } from "@/state/jobs";
import { useVizJob, useVizJobs } from "./useVizJob";

describe("useVizJob", () => {
  it("keeps the job id after the panel unmounts and announces completion", async () => {
    enqueue.mockResolvedValue([{ id: "vz1" }]);
    const first = renderHook(() => useVizJob("render"));
    await act(async () => first.result.current.start(["/a.wav"], {} as VisualizerOptions));
    expect(takeAnnounced("vz1")).toBe(true);
    first.unmount();
    // The drawer opened again follows the same job.
    expect(useVizJobs.getState().ids.render).toBe("vz1");
    expect(useVizJobs.getState().ids.preview).toBe("");
    const again = renderHook(() => useVizJob("render"));
    act(() => again.result.current.clear());
    expect(useVizJobs.getState().ids.render).toBe("");
  });
});
