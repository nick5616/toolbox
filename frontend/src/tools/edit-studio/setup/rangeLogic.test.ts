import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { parseSpeed, parseTransform } from "@/viz/edit/schema";
import { findClip, newClip } from "../doc";
import { changeRange, clampRange, nearestOf, quickPicks, shiftClips, snapRange, trimParamStart } from "./rangeLogic";

const a = buildEditFixture();
const base = normalizeProject(fixtureProject());

describe("clampRange", () => {
  it("keeps a valid range, enforces 1 s .. 10 min and the song's end", () => {
    expect(clampRange({ startMs: 2000, endMs: 9000 }, 24_000)).toEqual({ startMs: 2000, endMs: 9000 });
    expect(clampRange({ startMs: 2000, endMs: 2200 }, 24_000)).toEqual({ startMs: 2000, endMs: 3000 });
    expect(clampRange({ startMs: -50, endMs: 99_999 }, 24_000)).toEqual({ startMs: 0, endMs: 24_000 });
    expect(clampRange({ startMs: 23_800, endMs: 30_000 }, 24_000)).toEqual({ startMs: 23_000, endMs: 24_000 });
    expect(clampRange({ startMs: 0, endMs: 900_000 }, 900_000)).toEqual({ startMs: 0, endMs: 600_000 });
    expect(clampRange({ startMs: 0, endMs: 500 }, 500)).toEqual({ startMs: 0, endMs: 500 });
  });
});

describe("snapping", () => {
  const db = [0, 2000, 4000, 6000];
  it("nearestOf", () => {
    expect(nearestOf(db, 2900)).toBe(2000);
    expect(nearestOf(db, 3100)).toBe(4000);
    expect(nearestOf(db, 3000)).toBe(2000);
    expect(nearestOf(db, -10)).toBe(0);
    expect(nearestOf(db, 99_999)).toBe(6000);
    expect(nearestOf([], 5)).toBe(5);
  });
  it("snapRange moves the chosen edges", () => {
    expect(snapRange({ startMs: 1900, endMs: 5200 }, db, "both", 24_000)).toEqual({ startMs: 2000, endMs: 6000 });
    expect(snapRange({ startMs: 1900, endMs: 5200 }, db, "start", 24_000)).toEqual({ startMs: 2000, endMs: 5200 });
    expect(snapRange({ startMs: 1900, endMs: 5200 }, db, "end", 24_000)).toEqual({ startMs: 1900, endMs: 6000 });
  });
});

describe("quick picks", () => {
  const picks = Object.fromEntries(quickPicks(a, { startMs: 10_000, endMs: 20_000 }).map((p) => [p.id, p.range]));
  it("whole song, chorus, drop", () => {
    expect(picks.whole).toEqual({ startMs: 0, endMs: 24_000 });
    expect(picks["first-chorus"]).toEqual({ startMs: 8000, endMs: 16_000 });
    expect(picks["last-chorus"]).toEqual({ startMs: 8000, endMs: 16_000 });
    expect(picks.drop).toEqual({ startMs: 16_000, endMs: 24_000 });
  });
  it("N seconds from here, pulled back to fit the song", () => {
    expect(picks["15s"]).toEqual({ startMs: 9000, endMs: 24_000 });
    expect(picks["30s"]).toEqual({ startMs: 0, endMs: 24_000 });
    const early = quickPicks(a, { startMs: 2000, endMs: 9000 });
    expect(early.find((p) => p.id === "15s")?.range).toEqual({ startMs: 2000, endMs: 17_000 });
  });
  it("a missing part has no range", () => {
    const noChorus = a.audio.sections.filter((s) => s.label !== "chorus");
    const b = Object.create(a) as typeof a;
    Object.defineProperty(b, "audio", { value: { ...a.audio, sections: noChorus } });
    const p = quickPicks(b, { startMs: 0, endMs: 5000 });
    expect(p.find((x) => x.id === "first-chorus")?.range).toBeNull();
  });
});

describe("trimParamStart", () => {
  it("moves keys earlier and holds the value at the cut", () => {
    const p = { base: 1, keys: [{ t: 0, v: 0, ease: "linear" as const }, { t: 1000, v: 10, ease: "linear" as const }, { t: 2000, v: 0, ease: "ease" as const }] };
    const t = trimParamStart(p, 500);
    expect(t).toEqual({ base: 1, keys: [{ t: 0, v: 5, ease: "linear" }, { t: 500, v: 10, ease: "linear" }, { t: 1500, v: 0, ease: "ease" }] });
    expect(trimParamStart(p, 3000)).toEqual({ base: 1, keys: [{ t: 0, v: 0, ease: "ease" }] });
    expect(trimParamStart(5, 100)).toBe(5);
  });
});

describe("shiftClips", () => {
  it("moves clips earlier by the delta and keeps them on the music", () => {
    const r = shiftClips(base, 2000);
    expect(r.removed).toBe(0);
    expect(findClip(r.project, "c1")?.clip).toMatchObject({ startMs: 0, endMs: 6000, inMs: 3000 });
    // c1 started at 0: now starts before 0, so it was trimmed by 2000 ms
    expect(r.trimmed).toBe(1);
    expect(findClip(r.project, "c2")?.clip).toMatchObject({ startMs: 6000, endMs: 14_000 });
  });

  it("trims a video clip's front by source time and removes clips fully before 0", () => {
    const r = shiftClips(base, 9000);
    expect(findClip(r.project, "c1")).toBeNull(); // 0..8000 ends before 9000
    const c2 = findClip(r.project, "c2")?.clip;
    expect(c2).toMatchObject({ startMs: 0, endMs: 7000 }); // an image: inMs unchanged
    expect(c2?.inMs).toBe(0);
    const t = parseTransform(c2?.transform ?? "").value;
    // the scale keys 0..8000 (1 -> 1.15) shifted by 1000
    const scale = t.scale as { keys: Array<{ t: number; v: number }> };
    expect(scale.keys[0]).toMatchObject({ t: 0 });
    expect(scale.keys[0]?.v).toBeCloseTo(1 + 0.15 * (1000 / 8000), 5); // linear first segment at the cut
    expect(r.removed).toBe(1);
    expect(r.trimmed).toBe(1);
  });

  it("advances inMs of a video clip by the skipped source (speed 2x)", () => {
    const clip = newClip({ id: "v", kind: "video", path: "/a.mp4", startMs: 0, endMs: 10_000, inMs: 1000, speed: "2" });
    const p = { ...base, tracks: [{ ...base.tracks[0]!, clips: [clip] }] };
    const r = shiftClips(p, 1000);
    expect(findClip(r.project, "v")?.clip).toMatchObject({ startMs: 0, endMs: 9000, inMs: 3000, auto: false });
    expect(parseSpeed(findClip(r.project, "v")?.clip.speed ?? "").value).toBe(2);
  });

  it("moving the start later moves clips earlier; earlier start moves them later", () => {
    const later = shiftClips(base, -1000);
    expect(findClip(later.project, "c3")?.clip).toMatchObject({ startMs: 17_000, endMs: 25_000 });
    expect(later.removed + later.trimmed).toBe(0);
  });

  it("removes a clip left under one frame", () => {
    const clip = newClip({ id: "s", kind: "color", color: "#fff", startMs: 0, endMs: 1010 });
    const p = { ...base, tracks: [{ ...base.tracks[0]!, clips: [clip] }] };
    expect(shiftClips(p, 1000).removed).toBe(1);
  });

  it("a zero delta is the same project", () => {
    expect(shiftClips(base, 0).project).toBe(base);
  });
});

describe("changeRange", () => {
  it("sets the range and, when asked, keeps clips on the music", () => {
    const keep = changeRange(base, { startMs: 8000, endMs: 24_000 }, true);
    expect(keep.project.song).toMatchObject({ startMs: 8000, endMs: 24_000 });
    expect(findClip(keep.project, "c3")?.clip).toMatchObject({ startMs: 8000, endMs: 16_000 });
    expect(keep.removed).toBe(1);
    const loose = changeRange(base, { startMs: 8000, endMs: 24_000 }, false);
    expect(findClip(loose.project, "c3")?.clip).toMatchObject({ startMs: 16_000, endMs: 24_000 });
    expect(loose.removed).toBe(0);
  });
  it("an unchanged range returns the same project", () => {
    expect(changeRange(base, { startMs: 0, endMs: 24_000 }, true).project).toBe(base);
  });
});
