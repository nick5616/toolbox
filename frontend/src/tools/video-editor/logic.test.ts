import { describe, expect, it } from "vitest";
import vectors from "../../../../modules/videoeditor/testdata/timeline.json";
import type { VideoClip, VideoProject } from "@/lib/api";
import {
  appendClips,
  dropIndexAt,
  insertClips,
  clipFromInfo,
  deleteClip,
  emptyProject,
  fixTransitions,
  localWarnings,
  mapPostAspect,
  moveClip,
  setTransition,
  splitClip,
  trimClip,
  updateTitle,
  newTitle,
} from "./edit";
import { newHistory, pushHistory, redo, undo, HISTORY_LIMIT } from "./history";
import { clipIndexAt, fillTransform, joinFactors, layersAt, musicGain, photoMotion } from "./schedule";
import { durationMs, timeline, type TimedClip } from "./timeline";

function video(inMs: number, outMs: number, extra: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `c${inMs}-${outMs}-${Math.random()}`,
    kind: "video",
    path: "a.mp4",
    inMs,
    outMs,
    durationMs: 0,
    speed: 1,
    volume: 1,
    fit: "fill",
    fitColor: "#000000",
    panX: 0,
    panY: 0,
    zoom: 1,
    motion: "none",
    look: "none",
    transition: { kind: "cut", durationMs: 0 },
    ...extra,
  };
}

function photo(durationMs: number, extra: Partial<VideoClip> = {}): VideoClip {
  return video(0, 0, { kind: "image", path: "p.jpg", durationMs, ...extra });
}

function doc(clips: VideoClip[]): VideoProject {
  return { ...emptyProject("9:16"), clips };
}

describe("timeline mirror (shared Go vectors)", () => {
  for (const v of vectors) {
    it(v.name, () => {
      const clips = v.clips as unknown as TimedClip[];
      const spans = timeline(clips);
      expect(spans.map((s) => ({ startMs: s.startMs, endMs: s.endMs }))).toEqual(v.spans);
      expect(durationMs(clips)).toBe(v.totalMs);
    });
  }
});

describe("scheduler", () => {
  const clips = [
    video(1000, 4000, { transition: { kind: "fade", durationMs: 500 } }),
    video(0, 2000, { speed: 2 }),
  ];
  const spans = timeline(clips); // 0-3000, 2500-3500

  it("maps timeline time to source time with speed", () => {
    const [l] = layersAt(clips, spans, 1000);
    expect(l).toMatchObject({ index: 0, sourceMs: 2000, opacity: 1, role: "main" });
    const second = layersAt(clips, spans, 3200);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ index: 1, sourceMs: 1400 });
  });

  it("shows both clips during a crossfade, incoming on top", () => {
    const ls = layersAt(clips, spans, 2750);
    expect(ls.map((l) => l.index)).toEqual([0, 1]);
    expect(ls[0]).toMatchObject({ role: "outgoing", opacity: 1 });
    expect(ls[1]?.role).toBe("incoming");
    expect(ls[1]?.opacity).toBeCloseTo(0.5);
  });

  it("clamps to the last frame at and after the end, and handles empty", () => {
    expect(layersAt(clips, spans, 99999).map((l) => l.index)).toEqual([1]);
    expect(layersAt([], [], 0)).toEqual([]);
  });

  it("transition factors", () => {
    expect(joinFactors("dip", 0.25)).toMatchObject({ out: { opacity: 0.5 }, in: { opacity: 0 } });
    expect(joinFactors("dip", 0.75)).toMatchObject({ out: { opacity: 0 }, in: { opacity: 0.5 } });
    expect(joinFactors("slide", 0.5)).toMatchObject({ out: { offsetX: -0.5 }, in: { offsetX: 0.5 } });
    expect(joinFactors("cut", 0.5).in.opacity).toBe(1);
  });

  it("finds the clip at a time", () => {
    expect(clipIndexAt(spans, 100)).toBe(0);
    expect(clipIndexAt(spans, 2800)).toBe(1);
    expect(clipIndexAt(spans, 5000)).toBe(1);
  });

  it("frames fill with pan and zoom like the render", () => {
    // A square source in a 9:16 frame overflows horizontally.
    const a = fillTransform(1, 9 / 16, 1, 0, 0);
    expect(a).toEqual({ scale: 1, tx: 0, ty: 0 });
    const right = fillTransform(1, 9 / 16, 1, 1, 0);
    expect(right.tx).toBeLessThan(0);
    const left = fillTransform(1, 9 / 16, 1, -1, 0);
    expect(left.tx).toBeCloseTo(-right.tx);
    // A matching aspect has no room to pan without zoom.
    expect(fillTransform(9 / 16, 9 / 16, 1, 1, 1)).toMatchObject({ tx: 0, ty: 0 });
    expect(fillTransform(9 / 16, 9 / 16, 2, 1, 0).tx).toBeLessThan(0);
  });

  it("photo motion and music fades", () => {
    expect(photoMotion("in", 0).scale).toBe(1);
    expect(photoMotion("in", 1).scale).toBe(1.25);
    expect(photoMotion("out", 0).scale).toBe(1.25);
    expect(photoMotion("left", 0).tx).toBeLessThan(0);
    expect(photoMotion("left", 1).tx).toBeGreaterThan(0);
    expect(photoMotion("none", 0.5)).toEqual({ scale: 1, tx: 0 });
    const m = { volume: 0.8, fadeInMs: 1000, fadeOutMs: 2000 };
    expect(musicGain(m, 0, 10000)).toBe(0);
    expect(musicGain(m, 500, 10000)).toBeCloseTo(0.4);
    expect(musicGain(m, 5000, 10000)).toBeCloseTo(0.8);
    expect(musicGain(m, 9000, 10000)).toBeCloseTo(0.4);
  });
});

describe("edit operations", () => {
  const three = () =>
    doc([video(0, 3000, { id: "a" }), video(0, 3000, { id: "b" }), video(0, 3000, { id: "c" })]);
  const ids = (d: VideoProject) => (d.clips ?? []).map((c) => c.id);

  it("reorders", () => {
    expect(ids(moveClip(three(), 0, 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveClip(three(), 2, 0))).toEqual(["c", "a", "b"]);
    const d = three();
    expect(moveClip(d, 1, 1)).toBe(d);
  });

  it("deletes", () => {
    expect(ids(deleteClip(three(), 1))).toEqual(["a", "c"]);
  });

  it("trims video edges by timeline time and speed, inside the source", () => {
    let d = doc([video(1000, 5000, { speed: 2 })]);
    d = trimClip(d, 0, "start", 500, 10000); // 500 ms of timeline = 1000 ms of source
    expect(d.clips?.[0]?.inMs).toBe(2000);
    d = trimClip(d, 0, "end", 100000, 6000);
    expect(d.clips?.[0]?.outMs).toBe(6000);
    d = trimClip(d, 0, "end", -100000, 6000);
    expect(d.clips?.[0]?.outMs).toBe(2600); // in + 300 ms * 2
    d = trimClip(d, 0, "start", -100000, 6000);
    expect(d.clips?.[0]?.inMs).toBe(0);
  });

  it("trims photos by duration within 1-10 s", () => {
    let d = doc([photo(3000)]);
    d = trimClip(d, 0, "end", 2000);
    expect(d.clips?.[0]?.durationMs).toBe(5000);
    d = trimClip(d, 0, "end", 60000);
    expect(d.clips?.[0]?.durationMs).toBe(10000);
    d = trimClip(d, 0, "start", 60000);
    expect(d.clips?.[0]?.durationMs).toBe(1000);
  });

  it("splits at the playhead", () => {
    const d = doc([video(1000, 5000, { id: "a", speed: 2, transition: { kind: "fade", durationMs: 400 } }), video(0, 3000, { id: "b" })]);
    const s = splitClip(d, 0, 500, "n"); // clip is 2000 ms long
    expect(s).not.toBeNull();
    const clips = s?.clips ?? [];
    expect(clips.map((c) => c.id)).toEqual(["a", "n", "b"]);
    expect(clips[0]).toMatchObject({ inMs: 1000, outMs: 2000, transition: { kind: "cut" } });
    expect(clips[1]).toMatchObject({ inMs: 2000, outMs: 5000, transition: { kind: "fade", durationMs: 400 } });
    // Total length is unchanged by the split.
    expect(durationMs(clips) - 400).toBe(durationMs(d.clips ?? []) - 400);
  });

  it("refuses a split that leaves a sliver", () => {
    const d = doc([video(0, 3000), photo(2000)]);
    expect(splitClip(d, 0, 100)).toBeNull();
    expect(splitClip(d, 0, 2900)).toBeNull();
    expect(splitClip(d, 1, 3500)).toBeNull(); // photo halves need 1 s
    expect(splitClip(d, 1, 4000)?.clips).toHaveLength(3);
  });

  it("keeps transitions valid when clips shrink", () => {
    let d = doc([video(0, 3000, { transition: { kind: "fade", durationMs: 1000 } }), video(0, 3000)]);
    d = trimClip(d, 0, "end", -2000, 3000); // 1 s long: transition limited to 500
    expect(d.clips?.[0]?.transition.durationMs).toBe(500);
    d = trimClip(d, 0, "end", -600, 3000); // 0.4 s: no room for 200 ms+ ... half = 200
    expect(d.clips?.[0]?.transition).toMatchObject({ kind: "fade", durationMs: 200 });
    d = trimClip(d, 0, "end", -100, 3000);
    expect(d.clips?.[0]?.transition).toMatchObject({ kind: "cut", durationMs: 0 });
    expect(fixTransitions(d)).toBe(d);
  });

  it("sets transitions on joins only", () => {
    const d = three();
    const t = setTransition(d, 0, "dip", 600);
    expect(t.clips?.[0]?.transition).toEqual({ kind: "dip", durationMs: 600 });
    expect(setTransition(d, 2, "fade", 600)).toBe(d);
    expect(setTransition(t, 0, "cut", 600).clips?.[0]?.transition).toEqual({ kind: "cut", durationMs: 0 });
    expect(setTransition(d, 0, "fade", 99999).clips?.[0]?.transition.durationMs).toBe(1500);
  });

  it("builds clips from probe results", () => {
    const base = { path: "x", durationMs: 4000, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "" };
    expect(clipFromInfo({ ...base, kind: "video" }, "id")).toMatchObject({ kind: "video", inMs: 0, outMs: 4000, speed: 1 });
    expect(clipFromInfo({ ...base, kind: "audio" })).toBeNull();
    expect(clipFromInfo({ ...base, kind: "video", error: "x" })).toBeNull();
    const r = appendClips(emptyProject("1:1"), [
      { ...base, kind: "image", path: "1.jpg" },
      { ...base, kind: "image", path: "2.jpg" },
      { ...base, kind: "audio", path: "s.mp3" },
    ]);
    expect(r.added).toBe(2);
    expect(r.doc.clips?.map((c) => c.motion)).toEqual(["in", "out"]);
  });

  it("inserts clips at an index and finds the drop index", () => {
    const base = { path: "x", durationMs: 4000, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "", kind: "video" };
    const d = three();
    const n = (d.clips ?? []).length;
    const r = insertClips(d, [{ ...base, path: "n1.mp4" }, { ...base, path: "n2.mp4" }], 1);
    expect(r.added).toBe(2);
    expect(r.doc.clips?.map((c) => c.path).slice(1, 3)).toEqual(["n1.mp4", "n2.mp4"]);
    expect(r.doc.clips).toHaveLength(n + 2);
    expect(insertClips(d, [{ ...base, path: "e.mp4" }], 999).doc.clips?.at(-1)?.path).toBe("e.mp4");
    const spans = [
      { startMs: 0, lenMs: 2000 },
      { startMs: 2000, lenMs: 2000 },
    ];
    expect([dropIndexAt(spans, 500), dropIndexAt(spans, 1500), dropIndexAt(spans, 2900), dropIndexAt(spans, 3500), dropIndexAt([], 10)]).toEqual([0, 1, 1, 2, 0]);
  });

  it("titles clamp their times", () => {
    const d = { ...three(), titles: [{ ...newTitle(1000), id: "t1" }] };
    const u = updateTitle(d, "t1", { startMs: -50, durationMs: 10 });
    expect(u.titles?.[0]).toMatchObject({ startMs: 0, durationMs: 500 });
  });

  it("warns about missing files", () => {
    const d = { ...three(), music: { path: "s.mp3", offsetMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, duck: false, endWithMusic: false } };
    expect(localWarnings(d, new Set())).toEqual([]);
    expect(localWarnings(d, new Set(["a.mp4", "s.mp3"]))).toEqual(["3 clips' files are missing", "The song is missing"]);
    expect(localWarnings(emptyProject("9:16"), new Set())).toEqual(["Add at least one clip"]);
  });

  it("maps post aspects", () => {
    expect(mapPostAspect("3:4")).toBe("4:5");
    expect(mapPostAspect("1.91:1")).toBe("16:9");
    expect(mapPostAspect("1:1")).toBe("1:1");
  });
});

describe("history", () => {
  it("undoes and redoes", () => {
    let h = newHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    h = undo(undo(h));
    expect(h.present).toBe(0);
    expect(undo(h)).toBe(h);
    h = pushHistory(h, 9);
    expect(h.future).toEqual([]);
  });

  it("coalesces keyed changes within 800 ms", () => {
    let h = newHistory(0);
    h = pushHistory(h, 1, "vol", 1000);
    h = pushHistory(h, 2, "vol", 1500);
    h = pushHistory(h, 3, "vol", 2400);
    expect(h.past).toEqual([0, 2]);
    expect(h.present).toBe(3);
  });

  it("keeps at least 100 steps", () => {
    let h = newHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = pushHistory(h, i);
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(100);
  });
});
