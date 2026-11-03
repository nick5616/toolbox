import { describe, expect, it } from "vitest";
import type { EditMatteState, EditSourceState } from "@/lib/api";
import { emptyEditProject, normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "../doc";
import { exportChecks, exportClips, formatLength, normalizeHeight, rebuildRequest, sizeLabel, withoutCutouts } from "./checks";

const matte = (id: string, mode = "people") => ({
  mode,
  id,
  fromMs: 0,
  toMs: 3000,
  clicks: [],
  cutout: true,
  invert: false,
  feather: 0,
  stroke: { px: 0, color: "#ffffff" },
  glow: { amount: 0, color: "#ffffff" },
});

function project(): NormalProject {
  const p = emptyEditProject("9:16", 30, 1);
  p.song = { path: "/s.mp3", startMs: 0, endMs: 10_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  p.analysisKey = "k";
  p.tracks = [
    {
      id: "t1",
      kind: "video",
      name: "V",
      muted: false,
      locked: false,
      matte: "",
      clips: [
        newClip({ id: "a", kind: "video", path: "/a.mov", startMs: 0, endMs: 2000, matte: matte("m1") }),
        newClip({ id: "b", kind: "image", path: "/b.jpg", startMs: 2000, endMs: 4000 }),
        newClip({ id: "c", kind: "color", color: "#000000", startMs: 4000, endMs: 5000 }),
        newClip({ id: "late", kind: "video", path: "/late.mov", startMs: 10_000, endMs: 11_000 }),
      ],
    },
    { id: "t2", kind: "video", name: "M", muted: true, locked: false, matte: "", clips: [newClip({ id: "m", kind: "video", path: "/muted.mov", startMs: 0, endMs: 1000 })] },
  ];
  return normalizeProject(p);
}

const src = (path: string, over: Partial<EditSourceState> = {}): EditSourceState => ({
  path,
  info: { path, kind: "video", durationMs: 5000, width: 1, height: 1, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "" },
  preview: { stream: "s", index: "i", width: 1, height: 1, fps: 30, frames: 1 },
  image: "",
  shots: null,
  preparing: false,
  error: "",
  ...over,
});

describe("export helpers", () => {
  it("formats sizes and lengths", () => {
    expect(sizeLabel("9:16", 1080)).toBe("1080 × 1920");
    expect(sizeLabel("16:9", 720)).toBe("1280 × 720");
    expect(sizeLabel("4:5", 1440)).toBe("1440 × 1800");
    expect(formatLength(125_000)).toBe("2:05");
    expect(formatLength(0)).toBe("0:00");
    expect(normalizeHeight(1440)).toBe(1440);
    expect(normalizeHeight(0)).toBe(1080);
  });

  it("lists the visible clips of non-muted tracks", () => {
    expect(exportClips(project()).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("reports preparing, unprepared, missing and unready cut-outs", () => {
    const p = project();
    const sources: Record<string, EditSourceState> = { "/a.mov": src("/a.mov", { preparing: true }) };
    const r = exportChecks(p, sources, {});
    expect(r.clipCount).toBe(3);
    expect(r.preparing).toEqual(["/a.mov"]);
    expect(r.unprepared).toEqual(["/b.jpg"]); // no state yet
    expect(r.badMattes.map((c) => c.id)).toEqual(["a"]);
    expect(r.missing).toEqual([]);

    const ok = exportChecks(p, { "/a.mov": src("/a.mov"), "/b.jpg": src("/b.jpg", { image: "img.jpg" }) }, { m1: { id: "m1", ready: true } as EditMatteState });
    expect(ok.preparing).toEqual([]);
    expect(ok.unprepared).toEqual([]);
    expect(ok.badMattes).toEqual([]);

    const gone = exportChecks(p, { "/a.mov": src("/a.mov", { error: "This file doesn't exist any more" }), "/b.jpg": src("/b.jpg", { image: "x" }) }, { m1: { id: "m1", ready: true } as EditMatteState });
    expect(gone.missing).toEqual([{ path: "/a.mov", reason: "This file doesn't exist any more" }]);
  });

  it("builds the rebuild request from the clip and its speed curve", () => {
    const p = project();
    const clip = p.tracks[0]!.clips[0]!;
    const half = { ...clip, inMs: 500, speed: "0.5" };
    expect(rebuildRequest(half, 30)).toEqual({ clipId: "a", matteId: "m1", mode: "people", path: "/a.mov", fromMs: 500, toMs: 1500, clicks: [], preview: false });
    const img = { ...clip, kind: "image", matte: matte("m2", "image") };
    expect(rebuildRequest(img, 30)).toMatchObject({ mode: "image", fromMs: 0, toMs: 0 });
    expect(rebuildRequest({ ...clip, matte: null }, 30)).toBeNull();
  });

  it("removes cut-outs from the chosen clips only, in one document", () => {
    const p = project();
    const a = p.tracks[0]!.clips[0]!;
    const withFx: NormalProject = { ...p, tracks: [{ ...p.tracks[0]!, clips: [{ ...a, fxTarget: "subject" }, ...p.tracks[0]!.clips.slice(1)] }, p.tracks[1]!] };
    const next = withoutCutouts(withFx, new Set(["a"]));
    const na = next.tracks[0]!.clips[0]!;
    expect(na.matte).toBeNull();
    expect(na.fxTarget).toBe("clip");
    expect(next.tracks[0]!.clips[1]).toBe(withFx.tracks[0]!.clips[1]);
    expect(next.tracks[1]).toBe(withFx.tracks[1]);
  });
});
