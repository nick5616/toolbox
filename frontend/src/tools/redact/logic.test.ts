import { describe, expect, it } from "vitest";
import type { RedactBox, RedactTrack } from "@/lib/api";
import {
  DEFAULT_SETTINGS,
  applyVideoOverlay,
  classify,
  countLabel,
  effectParams,
  fromOverlay,
  imageApplyOptions,
  initialVideoState,
  overlayAt,
  removeBox,
  sampleAt,
  sanitizeSettings,
  setManualTime,
  toOverlay,
  toggleBox,
  videoApplyOptions,
} from "./logic";

const box = (over: Partial<RedactBox>): RedactBox => ({ id: "a", x: 0.1, y: 0.1, w: 0.2, h: 0.2, kind: "face", enabled: true, score: 0.9, ...over });
const track = (over: Partial<RedactTrack>): RedactTrack => ({
  id: "t1",
  kind: "face",
  startMs: 0,
  endMs: 1000,
  maxScore: 0.9,
  enabled: true,
  samples: [
    { ms: 0, x: 0, y: 0, w: 0.2, h: 0.2 },
    { ms: 1000, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  ],
  ...over,
});

describe("image boxes", () => {
  it("counts enabled boxes by kind", () => {
    const boxes = [box({ id: "1" }), box({ id: "2" }), box({ id: "3", kind: "plate" }), box({ id: "4", enabled: false }), box({ id: "5", kind: "manual" })];
    expect(countLabel(boxes)).toBe("2 faces · 1 plate · 1 manual box");
    expect(countLabel([box({ enabled: false })])).toBe("Nothing to hide");
    expect(countLabel([box({})])).toBe("1 face");
  });

  it("toggles and removes boxes without touching the others", () => {
    const boxes = [box({ id: "1" }), box({ id: "2" })];
    expect(toggleBox(boxes, "2").map((b) => b.enabled)).toEqual([true, false]);
    expect(removeBox(boxes, "1").map((b) => b.id)).toEqual(["2"]);
  });

  it("keeps scores and kinds when the overlay edits, and makes new boxes manual", () => {
    const prev = [box({ id: "1", score: 0.7, kind: "plate" })];
    const next = [{ ...toOverlay(prev[0]!), enabled: false, x: 0.3 }, { id: "n", x: 0.5, y: 0.5, w: 0.1, h: 0.1, kind: "manual" as const, enabled: true }];
    const out = fromOverlay(prev, next);
    expect(out[0]).toMatchObject({ id: "1", kind: "plate", score: 0.7, enabled: false, x: 0.3 });
    expect(out[1]).toMatchObject({ id: "n", kind: "manual", enabled: true, score: 1 });
  });

  it("builds apply options with every image's boxes", () => {
    const o = imageApplyOptions(DEFAULT_SETTINGS, ["/a.jpg", "/b.jpg"], { "/a.jpg": [box({})] });
    expect(o.action).toBe("apply");
    expect(Object.keys(o.imageBoxes ?? {})).toEqual(["/a.jpg", "/b.jpg"]);
    expect(o.imageBoxes?.["/b.jpg"]).toEqual([]);
    expect(o.imageBoxes?.["/a.jpg"]?.[0]?.id).toBe("a");
  });
});

describe("video tracks", () => {
  it("interpolates a track between samples and is null outside its span", () => {
    const t = track({});
    expect(sampleAt(t, 500)).toMatchObject({ x: 0.25, y: 0.25 });
    expect(sampleAt(t, 0)).toMatchObject({ x: 0, y: 0 });
    expect(sampleAt(t, 1001)).toBeNull();
    expect(sampleAt(track({ samples: [] }), 10)).toBeNull();
  });

  it("shows tracks and active manual boxes at the playhead", () => {
    const tracks = [track({}), track({ id: "t2", startMs: 2000, endMs: 3000 })];
    let st = initialVideoState(tracks);
    st = { ...st, manual: [{ id: "m1", x: 0, y: 0, w: 0.1, h: 0.1, kind: "manual", enabled: true, score: 1, startMs: 400, endMs: 900 }] };
    expect(overlayAt(tracks, st, 500).map((b) => b.id)).toEqual(["t1", "m1"]);
    expect(overlayAt(tracks, st, 2500).map((b) => b.id)).toEqual(["t2"]);
  });

  it("toggling a track box disables the track; false positives start off", () => {
    const tracks = [track({}), track({ id: "t2", enabled: false })];
    const st = initialVideoState(tracks);
    expect(st.tracks).toEqual({ t1: true, t2: false });
    const prev = overlayAt(tracks, st, 500);
    const next = prev.map((b) => (b.id === "t1" ? { ...b, enabled: false } : b));
    const out = applyVideoOverlay(st, tracks, prev, next, 500, 10_000);
    expect(out.tracks.t1).toBe(false);
  });

  it("drawing adds a manual box for 3 s from now, clamped to the duration; deleting removes it", () => {
    const tracks = [track({})];
    const st = initialVideoState(tracks);
    const drawn = { id: "m", x: 0.1, y: 0.1, w: 0.2, h: 0.2, kind: "manual" as const, enabled: true };
    const added = applyVideoOverlay(st, tracks, [], [drawn], 2000, 10_000);
    expect(added.manual[0]).toMatchObject({ id: "m", startMs: 2000, endMs: 5000, kind: "manual" });
    const clamped = applyVideoOverlay(st, tracks, [], [drawn], 9000, 10_000);
    expect(clamped.manual[0]?.endMs).toBe(10_000);
    const prev = overlayAt(tracks, added, 2500);
    const removed = applyVideoOverlay(added, tracks, prev, prev.filter((b) => b.id !== "m"), 2500, 10_000);
    expect(removed.manual).toEqual([]);
  });

  it("keeps manual start before end and inside the clip", () => {
    const tracks: RedactTrack[] = [];
    let st = applyVideoOverlay(initialVideoState(tracks), tracks, [], [{ id: "m", x: 0, y: 0, w: 0.1, h: 0.1, kind: "manual", enabled: true }], 1000, 10_000);
    st = setManualTime(st, "m", "start", 4000, 10_000);
    expect(st.manual[0]?.startMs).toBe(1000); // 4000 is not before the end (4000)
    st = setManualTime(st, "m", "end", 99_999, 10_000);
    expect(st.manual[0]?.endMs).toBe(10_000);
    st = setManualTime(st, "m", "start", 4000, 10_000);
    expect(st.manual[0]?.startMs).toBe(4000);
    st = setManualTime(st, "m", "end", 3000, 10_000);
    expect(st.manual[0]?.endMs).toBe(10_000);
  });

  it("builds apply options with disabled tracks and enabled manual boxes only", () => {
    const tracks = [track({}), track({ id: "t2", enabled: false })];
    let st = initialVideoState(tracks);
    st = applyVideoOverlay(st, tracks, [], [{ id: "m", x: 0, y: 0, w: 0.1, h: 0.1, kind: "manual", enabled: true }], 0, 5000);
    const o = videoApplyOptions(DEFAULT_SETTINGS, "/cache/redact/j.json", tracks, st);
    expect(o).toMatchObject({ action: "apply", detectionsPath: "/cache/redact/j.json", disabledTracks: ["t2"] });
    expect(o.manualBoxes).toHaveLength(1);
  });
});

describe("settings and helpers", () => {
  it("sanitizes remembered settings", () => {
    expect(sanitizeSettings(null, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ faces: false, style: "pixelate", strength: 99, padding: -4, sensitivity: "nope", stripMetadata: "x" }, DEFAULT_SETTINGS);
    expect(s).toMatchObject({ faces: false, style: "pixelate", strength: 10, padding: 0, sensitivity: "normal", stripMetadata: true });
  });

  it("splits files into images and videos", () => {
    expect(classify(["/a.JPG", "/b.mp4", "/c.heic"])).toEqual({ images: ["/a.JPG", "/c.heic"], videos: ["/b.mp4"] });
  });

  it("scales the preview effect like the engine", () => {
    expect(effectParams("blur", 6, 100, 50).sigma).toBeCloseTo((0.04 + 0.016 * 6) * 50);
    expect(effectParams("pixelate", 6, 100, 50).block).toBeCloseTo(5);
    expect(effectParams("solid", 6, 100, 50)).toEqual({ sigma: 0, block: 1 });
  });
});
