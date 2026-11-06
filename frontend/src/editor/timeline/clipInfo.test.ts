import { describe, expect, it } from "vitest";
import type { EditSourceState } from "@/lib/api";
import { newClip } from "@/editor/doc";
import { clipLabel, clipStatus, hasSpeedChange, sourceWindow, stripStyle } from "./clipInfo";

const state = (over: Partial<Omit<EditSourceState, "info">> & { info?: Partial<EditSourceState["info"]> } = {}): EditSourceState => {
  const { info, ...rest } = over;
  return {
  path: "/a.mp4",
  info: { path: "/a.mp4", kind: "video", durationMs: 10_000, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "", ...info } as EditSourceState["info"],
  preview: { stream: "/s", index: "/i", width: 540, height: 960, fps: 30, frames: 300 },
  image: "",
  shots: null,
  preparing: false,
  error: "",
  ...rest,
  };
};
const video = newClip({ kind: "video", path: "/a.mp4", startMs: 0, endMs: 1000 });

describe("clipStatus", () => {
  it("is ok for non-media clips and unknown sources", () => {
    expect(clipStatus(newClip({ kind: "color", startMs: 0, endMs: 1 }), undefined)).toBe("ok");
    expect(clipStatus(video, undefined)).toBe("ok");
  });
  it("flags missing files and preparing sources", () => {
    expect(clipStatus(video, state())).toBe("ok");
    expect(clipStatus(video, state({ info: { error: "not found" } }))).toBe("missing");
    expect(clipStatus(video, state({ preparing: true }))).toBe("preparing");
    expect(clipStatus(video, state({ preview: null }))).toBe("preparing");
    expect(clipStatus(video, state({ preview: null, error: "boom" }))).toBe("missing");
  });
  it("a photo is ready with its preview image", () => {
    const photo = newClip({ kind: "image", path: "/p.jpg", startMs: 0, endMs: 1000 });
    expect(clipStatus(photo, state({ info: { kind: "image" }, preview: null, image: "/img.png" }))).toBe("ok");
    expect(clipStatus(photo, state({ info: { kind: "image" }, preview: null, image: "" }))).toBe("preparing");
  });
});

describe("labels and strips", () => {
  it("labels", () => {
    expect(clipLabel(video)).toBe("a.mp4");
    expect(clipLabel(newClip({ kind: "image", path: "C:\\x\\p.jpg", startMs: 0, endMs: 1 }))).toBe("p.jpg");
    expect(clipLabel(newClip({ kind: "adjust", startMs: 0, endMs: 1 }))).toBe("Adjustment");
  });
  it("speed badge", () => {
    expect(hasSpeedChange(video)).toBe(false);
    expect(hasSpeedChange({ speed: "2" })).toBe(true);
  });
  it("positions the sprite window", () => {
    expect(stripStyle(0, 10_000, 10_000)).toEqual({ backgroundSize: "100% 100%", backgroundPosition: "0 0" });
    expect(stripStyle(5000, 7500, 10_000)).toEqual({ backgroundSize: "400% 100%", backgroundPosition: "66.66666666666666% 0" });
  });
  it("source window follows speed", () => {
    expect(sourceWindow(newClip({ kind: "video", startMs: 0, endMs: 1000, inMs: 500 }), 30)).toEqual({ fromMs: 500, toMs: 1500 });
    expect(sourceWindow(newClip({ kind: "video", startMs: 0, endMs: 1000, inMs: 0, speed: "2" }), 30).toMs).toBe(2000);
  });
});
