import { describe, expect, it } from "vitest";
import type { EditMatte } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { allClips, findClip, newTrack, withClip } from "@/editor/doc";
import { splitSubject } from "./split";

const matte = (over: Partial<EditMatte> = {}): EditMatte => ({
  mode: "people",
  id: "m1",
  fromMs: 0,
  toMs: 9000,
  clicks: [],
  cutout: false,
  invert: false,
  feather: 0.2,
  stroke: { px: 4, color: "#ffffff" },
  glow: { amount: 0.3, color: "#ffffff" },
  ...over,
});

function withMatte(over: Partial<EditMatte> = {}): NormalProject {
  const p = normalizeProject(fixtureProject());
  return withClip(p, "c1", { matte: matte(over), volume: 1, fxTarget: "subject" });
}

describe("splitSubject", () => {
  it("puts a cut-out copy on a new video track directly above, same timing and effects (the subject stays over its background)", () => {
    const p = withMatte();
    const out = splitSubject(p, "c1");
    expect(out).not.toBeNull();
    const q = out as NormalProject;
    expect(q.tracks.map((t) => t.id).slice(0, 1)).toEqual(["t1"]);
    expect(q.tracks).toHaveLength(p.tracks.length + 1);
    const above = q.tracks[1];
    expect(above?.kind).toBe("video");
    expect(above?.clips).toHaveLength(1);
    const copy = above?.clips[0];
    const orig = findClip(q, "c1")?.clip;
    expect(copy?.id).not.toBe("c1");
    expect(copy).toMatchObject({ kind: "video", path: "/fixture/a.mp4", startMs: 0, endMs: 8000, inMs: 1000, volume: 0 });
    expect(copy?.effects).toBe(orig?.effects);
    expect(copy?.matte).toMatchObject({ id: "m1", cutout: true });
    // the lower clip stays as the background (its effects are kept)
    expect(orig?.effects).not.toBe("");
    expect(orig?.matte?.cutout).toBe(false);
    // the adjustment track (index 1 before) moved up with everything above
    expect(q.tracks[2]?.id).toBe("t2");
  });

  it("is a pure function of the document", () => {
    const p = withMatte();
    const before = JSON.stringify(p);
    splitSubject(p, "c1");
    expect(JSON.stringify(p)).toBe(before);
  });

  it("turns the lower clip's cut-out off when it was on (the subject now lives on the copy)", () => {
    const q = splitSubject(withMatte({ cutout: true }), "c1") as NormalProject;
    expect(findClip(q, "c1")?.clip.matte?.cutout).toBe(false);
    expect(q.tracks[1]?.clips[0]?.matte?.cutout).toBe(true);
  });

  it("handles photo clips with an image matte", () => {
    const p = withClip(normalizeProject(fixtureProject()), "c2", { matte: matte({ mode: "image", id: "ph" }) });
    const q = splitSubject(p, "c2");
    expect(q).not.toBeNull();
    expect(allClips(q as NormalProject).filter((r) => r.clip.path === "/fixture/photo.jpg")).toHaveLength(2);
  });

  it("returns null without a matte, for unknown clips, adjustment clips and a full project", () => {
    const p = normalizeProject(fixtureProject());
    expect(splitSubject(p, "c1")).toBeNull();
    expect(splitSubject(p, "nope")).toBeNull();
    expect(splitSubject(withClip(p, "c4", { matte: matte() }), "c4")).toBeNull();
    let full = withMatte();
    while (full.tracks.length < 8) full = { ...full, tracks: [...full.tracks, { ...newTrack("video", `Extra ${full.tracks.length}`), clips: [] }] };
    expect(splitSubject(full, "c1")).toBeNull();
  });

  it("a split at 7 tracks reaches the limit of 8", () => {
    let p = withMatte();
    while (p.tracks.length < 7) p = { ...p, tracks: [...p.tracks, { ...newTrack("video", `Extra ${p.tracks.length}`), clips: [] }] };
    expect(splitSubject(p, "c1")?.tracks).toHaveLength(8);
  });

  it("names the track within 40 characters", () => {
    const p = withMatte();
    const long = { ...p, tracks: p.tracks.map((t) => (t.id === "t1" ? { ...t, name: "x".repeat(40) } : t)) };
    expect((splitSubject(long, "c1")?.tracks[1]?.name ?? "").length).toBeLessThanOrEqual(40);
  });
});
