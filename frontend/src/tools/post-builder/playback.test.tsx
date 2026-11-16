import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  opened: [] as (string | null)[],
  fresh: { current: "" },
  preview: vi.fn(async (_id: string) => ({ id: "job1", moduleId: "video-editor", status: "queued", progress: 0 })),
  thumb: vi.fn(async (_p: string, _d: number) => "data:image/png;base64,AA=="),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { ImageThumb: (p: string, d: number) => h.thumb(p, d) },
    ComposerService: { LoadImage: async () => "" },
    MediaService: { Frame: async () => "/media/t/frame.jpg" },
    VideoEditorService: {
      FreshPreviewPath: async () => h.fresh.current,
      PreviewPath: async () => "/projects/v1/preview.mp4",
      Preview: (id: string) => h.preview(id),
    },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  return {
    ...actual,
    useMediaSource: (path: string | null) => {
      h.opened.push(path);
      return path
        ? { status: "ready", source: { url: `/media/tok/${path.split("/").pop()}`, info: { startMs: 0, durationMs: 10000 } }, retry: vi.fn() }
        : { status: "idle", retry: vi.fn() };
    },
  };
});

import type { PostSlide } from "@/lib/api";
import { takeMuted } from "@/state/jobs";
import { SlideStage } from "./SlideStage";
import { clearVisualCache, loadVisual, STAGE_DIM, useSlideVisual } from "./useSlideVisual";

function slide(extra: Partial<PostSlide>): PostSlide {
  return { id: "s1", kind: "photo", path: "/p/a.jpg", projectId: "", panX: 0, panY: 0, zoom: 1, rotation: 0, inMs: 0, outMs: 0, mute: false, altText: "", ...extra } as PostSlide;
}

function stage(s: PostSlide) {
  return render(<SlideStage slide={s} aspect="4:5" project={undefined} onChange={() => undefined} onEdit={() => undefined} stillMs={s.inMs} />);
}

beforeEach(() => {
  clearVisualCache();
  h.opened.length = 0;
  h.fresh.current = "";
  h.preview.mockClear();
  h.thumb.mockClear();
});
afterEach(cleanup);

describe("switching slides", () => {
  it("shows a picture that already loaded in the first render", async () => {
    const s = slide({});
    await loadVisual(s, undefined, STAGE_DIM);
    const { result } = renderHook(() => useSlideVisual(s, undefined, STAGE_DIM));
    expect(result.current).toMatchObject({ url: "data:image/png;base64,AA==", status: "ready" });
    expect(h.thumb).toHaveBeenCalledTimes(1);
  });
});

describe("playing slides", () => {
  it("photos have no play bar", async () => {
    stage(slide({}));
    await waitFor(() => expect(screen.getByTestId("framed-media").querySelector("img")).toBeTruthy());
    expect(screen.queryByTestId("slide-playbar")).toBeNull();
  });

  it("a clip opens its file only when Play is pressed, then plays it in the frame", async () => {
    stage(slide({ kind: "clip", path: "/v/zoo.mp4", inMs: 2000, outMs: 6000 }));
    const play = await screen.findByRole("button", { name: "Play" });
    expect(h.opened.every((p) => p === null)).toBe(true);
    expect(screen.getByTestId("framed-media").querySelector("video")).toBeNull();
    fireEvent.click(play);
    await waitFor(() => expect(screen.getByTestId("framed-media").querySelector("video")?.getAttribute("src")).toBe("/media/tok/zoo.mp4"));
    expect(h.opened).toContain("/v/zoo.mp4");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    // The length is In to Out.
    expect(screen.getByTestId("slide-playbar").textContent).toContain("0:04");
  });

  it("a video slide without an up-to-date preview makes one quietly, then plays it", async () => {
    stage(slide({ kind: "video", path: "", projectId: "v1" }));
    await screen.findByRole("img", { name: "Press Play to make a preview of this video" });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(h.preview).toHaveBeenCalledWith("v1"));
    expect(takeMuted("job1")).toBe(true);
  });

  it("a video slide with a fresh preview plays it without rendering", async () => {
    h.fresh.current = "/projects/v1/preview.mp4";
    stage(slide({ kind: "video", path: "", projectId: "v1" }));
    const play = await screen.findByRole("button", { name: "Play" });
    await act(async () => void fireEvent.click(play));
    await waitFor(() => expect(h.opened).toContain("/projects/v1/preview.mp4"));
    expect(h.preview).not.toHaveBeenCalled();
  });
});
