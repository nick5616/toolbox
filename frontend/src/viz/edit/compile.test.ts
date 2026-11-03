import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { buildEditFixture, fixtureProject } from "./fixture";
import { clipAt, clipFramePlan, compileEdit, frameAtTime, frameSpan, integrateSpeed, needsAt, outgoingOf, transitionMix, type CompiledEditFull } from "./compile";
import type { EditFiles, EditProject } from "./types";

const analysis = buildEditFixture();

function clip(over: Partial<EditClip> & { id: string; startMs: number; endMs: number }): EditClip {
  return {
    kind: "video",
    path: "/a.mp4",
    color: "",
    inMs: 0,
    speed: "",
    slow: "",
    volume: 0,
    fit: "fill",
    fitColor: "#000000",
    flipX: false,
    blend: "normal",
    transform: "",
    matte: null,
    fxTarget: "clip",
    masks: "",
    effects: "",
    in: "",
    text: "",
    visual: "",
    pinned: false,
    auto: false,
    ...over,
  };
}

function project(clips: EditClip[], extra: Partial<EditProject> = {}): EditProject {
  const p = fixtureProject();
  p.tracks = [{ id: "t1", kind: "video", name: "V", muted: false, locked: false, matte: "", clips }];
  p.captions = null;
  return { ...p, ...extra };
}

const files = (streams: string[] = ["v:/a.mp4"], images: string[] = []): EditFiles => ({
  streams: Object.fromEntries(streams.map((k) => [k, { url: `u:${k}`, indexUrl: `i:${k}` }])),
  images: Object.fromEntries(images.map((k) => [k, `u:${k}`])),
});

function build(p: EditProject, f: EditFiles = files(), extra: { streamFrames?: Record<string, number> } = {}): CompiledEditFull {
  return compileEdit({ project: p, analysis, markers: [], files: f }, { width: 540, height: 960, fps: p.fps, ...extra });
}

describe("frame grid", () => {
  it("maps k·1000/fps back to k", () => {
    for (const fps of [30, 60]) for (let k = 0; k < 1500; k++) expect(frameAtTime((k * 1000) / fps, fps, 100_000)).toBe(k);
    expect(frameAtTime(-5, 30, 100)).toBe(0);
    expect(frameAtTime(1e9, 30, 100)).toBe(99);
  });

  it("spans follow the cut offset", () => {
    expect(frameSpan(0, 1000, 30, 0)).toEqual({ k0: 0, k1: 30 });
    expect(frameSpan(0, 1000, 30, 2)).toEqual({ k0: 2, k1: 32 });
    expect(frameSpan(1000, 2000, 30, -3)).toEqual({ k0: 27, k1: 57 });
    expect(frameSpan(1010, 2000, 30, 0)).toEqual({ k0: 31, k1: 60 }); // starts on the first frame at or after
  });

  for (const off of [-3, -1, 0, 1, 3]) {
    it(`compiles clip spans with cut offset ${off}`, () => {
      const c = build(project([clip({ id: "a", startMs: 1000, endMs: 2000 }), clip({ id: "b", startMs: 2000, endMs: 3000 })], { cutOffsetFrames: off }));
      const [a, b] = c.tracks[0]?.clips ?? [];
      expect(a?.k0).toBe(30 + off);
      expect(a?.k1).toBe(60 + off);
      expect(b?.k0).toBe(a?.k1); // adjacent clips stay adjacent
      expect(c.cutOffsetFrames).toBe(off);
      expect(clipAt(c.tracks[0]!, 30 + off)?.id).toBe("a");
      expect(clipAt(c.tracks[0]!, 60 + off)?.id).toBe("b");
    });
  }

  it("clamps the first clip to the start and drops clips outside the edit", () => {
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 1000 }), clip({ id: "z", startMs: 30_000, endMs: 31_000 })], { cutOffsetFrames: -3 }));
    expect(c.tracks[0]?.clips.map((x) => [x.id, x.k0, x.k1])).toEqual([["a", 0, 27]]);
    expect(c.frames).toBe(720);
    expect(c.durationMs).toBe(24_000);
  });
});

describe("source tables", () => {
  it("integrates constant speed", () => {
    const t = integrateSpeed(4, 30, 30, 1000, 30, () => 1);
    expect([...t.src]).toEqual([30, 31, 32, 33]);
    const h = integrateSpeed(4, 0, 0, 0, 30, () => 0.5);
    expect([...h.src]).toEqual([0, 0.5, 1, 1.5]);
    expect([...h.adv]).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("integrates a ramp on the output grid", () => {
    // speed(u) = 1 + u/1000 (u in clip ms), at 10 fps: u = 0, 100, 200...
    const t = integrateSpeed(4, 0, 0, 0, 10, (u) => 1 + u / 1000);
    expect(t.src[0]).toBeCloseTo(0, 6);
    expect(t.src[1]).toBeCloseTo(1, 6);
    expect(t.src[2]).toBeCloseTo(2.1, 6);
    expect(t.src[3]).toBeCloseTo(3.3, 6);
  });

  it("uses clip-relative time (frames before the clip's start are offset)", () => {
    let seen = -1;
    integrateSpeed(1, 0, 3, 50, 30, (u) => ((seen = u), 1));
    expect(seen).toBeCloseTo(50, 6); // frame 3 is at 100 ms, the clip starts at 50 ms
  });

  it("freezes at speed 0 and clamps to 0..4", () => {
    const z = integrateSpeed(3, 12, 0, 0, 30, () => 0);
    expect([...z.src]).toEqual([12, 12, 12]);
    const f = integrateSpeed(3, 0, 0, 0, 30, () => 9);
    expect([...f.adv]).toEqual([4, 4, 4]);
  });

  it("holds the last frame at the cap", () => {
    const t = integrateSpeed(6, 8, 0, 0, 30, () => 1, 10);
    expect([...t.src]).toEqual([8, 9, 10, 10, 10, 10]);
  });

  it("compileEdit: src starts at InMs and advances at the speed", () => {
    const c = build(project([clip({ id: "a", startMs: 1000, endMs: 2000, inMs: 500, speed: "2" })]));
    const a = c.tracks[0]?.clips[0];
    expect(a?.src?.[0]).toBe(15);
    expect(a?.src?.[3]).toBe(21);
    expect(a?.src?.length).toBe(30);
  });

  it("caps positions at the stream's last frame when its length is known", () => {
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 2000, inMs: 0 })]), files(), { streamFrames: { "v:/a.mp4": 20 } });
    const a = c.tracks[0]?.clips[0];
    expect(a?.src?.[19]).toBe(19);
    expect(a?.src?.[59]).toBe(19);
  });
});

describe("needs", () => {
  it("lists one frame per drawn video clip at speed 1", () => {
    const c = build(project([clip({ id: "a", startMs: 1000, endMs: 2000, inMs: 100 })]));
    expect(needsAt(c, 30)).toEqual([{ stream: "v:/a.mp4", frame: 3 }]);
    expect(needsAt(c, 29)).toEqual([]);
    expect(needsAt(c, 60)).toEqual([]);
  });

  it("lists both neighbours when slow motion blends, one when it lands on a frame", () => {
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "0.5" })]));
    expect(needsAt(c, 1)).toEqual([
      { stream: "v:/a.mp4", frame: 0 },
      { stream: "v:/a.mp4", frame: 1 },
    ]);
    expect(needsAt(c, 2)).toEqual([{ stream: "v:/a.mp4", frame: 1 }]);
    const none = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "0.5", slow: "none" })]));
    expect(needsAt(none, 1)).toHaveLength(1);
    const fast = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "1.5" })]));
    expect(needsAt(fast, 1)).toHaveLength(1); // speeding up rounds
  });

  it("adds the matte frames, mapped to the matte's own start", () => {
    const m = { mode: "people", id: "m1", fromMs: 1000, toMs: 5000, clicks: [], cutout: true, invert: false, feather: 0, stroke: { px: 0, color: "#ffffff" }, glow: { amount: 0, color: "#ffffff" } };
    const p = project([clip({ id: "a", startMs: 0, endMs: 2000, inMs: 1500, matte: m })]);
    const c = build(p, files(["v:/a.mp4", "m:m1"]));
    expect(needsAt(c, 0)).toEqual([
      { stream: "v:/a.mp4", frame: 45 },
      { stream: "m:m1", frame: 15 },
    ]);
    // a matte whose files don't exist yet is not used
    const missing = build(p, files());
    expect(needsAt(missing, 0)).toEqual([{ stream: "v:/a.mp4", frame: 45 }]);
    expect(missing.tracks[0]?.clips[0]?.matteMissing).toBe(true);
    expect(missing.tracks[0]?.clips[0]?.fxTarget).toBe("clip");
    // a slow clip blends the matte too
    const slow = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "0.5", matte: { ...m, fromMs: 0 } })]), files(["v:/a.mp4", "m:m1"]));
    expect(needsAt(slow, 1).map((k) => `${k.stream}#${k.frame}`)).toEqual(["v:/a.mp4#0", "v:/a.mp4#1", "m:m1#0", "m:m1#1"]);
  });

  it("uses an image matte and a photo as image keys", () => {
    const m = { mode: "image", id: "m2", fromMs: 0, toMs: 0, clicks: [], cutout: true, invert: false, feather: 0, stroke: { px: 0, color: "#ffffff" }, glow: { amount: 0, color: "#ffffff" } };
    const c = build(project([clip({ id: "p", kind: "image", path: "/p.jpg", startMs: 0, endMs: 1000, matte: m })]), files([], ["p:/p.jpg", "m:m2"]));
    expect(needsAt(c, 3)).toEqual([
      { stream: "p:/p.jpg", frame: 0 },
      { stream: "m:m2", frame: 0 },
    ]);
  });

  it("reads the interp stream where it covers the position and blends elsewhere", () => {
    const f = files(["v:/a.mp4", "i:/a.mp4|0-4"]);
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "0.25", slow: "interpolate" })]), f);
    // position 1 (frame) = 33.3 ms of source → interp frame 4 (4 × 30 fps)
    const plan = clipFramePlan(c.tracks[0]!.clips[0]!, 4, 30);
    expect(plan.main).toEqual({ stream: "i:/a.mp4|0-4", f0: 4, f1: 4, w: 0 });
    // without the stream it falls back to blending the base frames
    const base = build(project([clip({ id: "a", startMs: 0, endMs: 2000, speed: "0.25", slow: "interpolate" })]), files());
    expect(clipFramePlan(base.tracks[0]!.clips[0]!, 2, 30).main).toEqual({ stream: "v:/a.mp4", f0: 0, f1: 1, w: 0.5 });
  });
});

describe("transitions", () => {
  const two = (gapMs = 0, ms = 300) =>
    build(project([clip({ id: "a", startMs: 0, endMs: 1000 }), clip({ id: "b", startMs: 1000 + gapMs, endMs: 2000, path: "/b.mp4", in: JSON.stringify({ kind: "crossfade", ms }) })]), files(["v:/a.mp4", "v:/b.mp4"]));

  it("opens a window at the cut with the previous clip as the outgoing side", () => {
    const c = two();
    const t = c.tracks[0]!;
    const [a, b] = t.clips as [NonNullable<ReturnType<typeof clipAt>>, NonNullable<ReturnType<typeof clipAt>>];
    expect(b.trEnd).toBe(39); // (1000 + 300) ms at 30 fps
    expect(outgoingOf(t, b)?.id).toBe("a");
    expect(a.tail).toBe(9);
    expect(a.src?.length).toBe(39);
    expect(transitionMix(b, 1000, 30)).toBe(0);
    expect(transitionMix(b, 1150, 34)).toBeCloseTo(0.5, 6);
    expect(transitionMix(b, 1300, 39)).toBeNull();
    // the outgoing clip keeps playing past its end
    expect(needsAt(c, 32)).toEqual([
      { stream: "v:/b.mp4", frame: 2 },
      { stream: "v:/a.mp4", frame: 32 },
    ]);
    expect(needsAt(c, 40)).toEqual([{ stream: "v:/b.mp4", frame: 10 }]);
  });

  it("has a transparent outgoing side when there's a gap", () => {
    const c = two(500);
    const b = c.tracks[0]!.clips[1]!;
    expect(outgoingOf(c.tracks[0]!, b)).toBeNull();
    expect(needsAt(c, 46)).toEqual([{ stream: "v:/b.mp4", frame: 1 }]);
  });

  it("caps the length at the clip and at 2 s", () => {
    const short = build(project([clip({ id: "b", startMs: 0, endMs: 200, in: JSON.stringify({ kind: "flash", ms: 2000 }) })]));
    expect(short.tracks[0]?.clips[0]?.transition.ms).toBe(200);
    expect(short.tracks[0]?.clips[0]?.trEnd).toBe(6);
    const cut = build(project([clip({ id: "b", startMs: 0, endMs: 2000, in: JSON.stringify({ kind: "cut", ms: 500 }) })]));
    expect(cut.tracks[0]?.clips[0]?.trEnd).toBe(0);
  });
});

describe("problems and dropped fields", () => {
  it("reports invalid JSON with the field path and falls back", () => {
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 1000, effects: "{nope", transform: '{"scale": 99}', masks: "[1]", in: '{"kind":"spiral"}', speed: "[" })]));
    const text = c.problems.join("\n");
    expect(text).toContain("tracks[0].clips[0].effects");
    expect(text).toContain("tracks[0].clips[0].transform");
    expect(text).toContain("tracks[0].clips[0].masks");
    expect(text).toContain("tracks[0].clips[0].in");
    expect(text).toContain("tracks[0].clips[0].speed");
    const a = c.tracks[0]!.clips[0]!;
    expect(a.effects).toEqual([]);
    expect(a.speed).toBe(1);
    expect(a.transition.kind).toBe("cut");
  });

  it("drops stateful posts (feedback) with a problem", () => {
    const fx = JSON.stringify([
      { id: "f", type: "feedback", enabled: true, params: {} },
      { id: "g", type: "grade", enabled: true, params: { saturation: 1.2 } },
    ]);
    const c = build(project([clip({ id: "a", startMs: 0, endMs: 1000, effects: fx })]));
    expect(c.tracks[0]?.clips[0]?.effects.map((e) => e.type)).toEqual(["grade"]);
    expect(c.problems.some((m) => m.includes("feedback"))).toBe(true);
  });

  it("compiles the fixture project without problems", () => {
    const c = build(fixtureProject(), files(["v:/fixture/a.mp4", "v:/fixture/b.mp4"], ["p:/fixture/photo.jpg"]));
    expect(c.problems).toEqual([]);
    expect(c.tracks).toHaveLength(2);
    expect(c.tracks[1]?.kind).toBe("adjust");
    expect(c.captions).not.toBeNull();
    expect(c.frames).toBe(720);
    expect(needsAt(c, 270)).toEqual([{ stream: "p:/fixture/photo.jpg", frame: 0 }]);
  });
});
