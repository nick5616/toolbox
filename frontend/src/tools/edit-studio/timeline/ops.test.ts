import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { newClip } from "../doc";
import {
  addTrack,
  deleteClips,
  duplicateClips,
  insertAdjustClip,
  insertClip,
  insertClipAt,
  moveClips,
  neighbourMarker,
  reorderTrack,
  removeTrack,
  renameTrack,
  setTrackKind,
  setTrackLocked,
  setTrackMuted,
  sliceAtMarkers,
  splitAt,
  trimClip,
} from "./ops";

const vid = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "video", path: "/a.mp4", startMs, endMs, ...over });

/** A 24 s, 30 fps edit with the given clips on t1 (and an empty adjust track t2). */
function doc(clips: EditClip[], extra: Partial<NormalProject> = {}): NormalProject {
  const p = normalizeProject(fixtureProject());
  return {
    ...p,
    tracks: [
      { ...(p.tracks[0] as NormalProject["tracks"][number]), clips },
      { ...(p.tracks[1] as NormalProject["tracks"][number]), clips: [] },
    ],
    ...extra,
  };
}
const clipsOf = (p: NormalProject | null, track = 0): EditClip[] => (p?.tracks[track]?.clips ?? []).slice().sort((a, b) => a.startMs - b.startMs);
const spans = (p: NormalProject | null, track = 0): Array<[number, number]> => clipsOf(p, track).map((c) => [c.startMs, c.endMs]);

describe("insertClip", () => {
  const video = { kind: "video" as const, path: "/b.mp4", durationMs: 30_000 };
  const photo = { kind: "image" as const, path: "/p.jpg" };
  const markers = [1000, 2500, 4000, 9000];

  const cases: Array<[string, Parameters<typeof insertClip>[2], number, "fill-next" | "source", EditClip[], [number, number] | null]> = [
    ["fill-next to the next marker", video, 0, "fill-next", [], [0, 1000]],
    ["fill-next from between markers", video, 1200, "fill-next", [], [1200, 2500]],
    ["fill-next with no later marker: source length, capped at D", video, 9500, "fill-next", [], [9500, 24_000]],
    ["fill-next photo with no marker: 2 s", photo, 10_000, "fill-next", [], [10_000, 12_000]],
    ["source mode: the video's length, cut at D", video, 0, "source", [], [0, 24_000]],
    ["source mode: photo 2 s", photo, 3000, "source", [], [3000, 5000]],
    ["cut to the gap before the next clip", video, 0, "fill-next", [vid("x", 700, 900)], [0, 700]],
    ["a drop on an occupied point lands after the clip", photo, 500, "source", [vid("x", 0, 1000)], [1000, 3000]],
    ["chained occupied clips", photo, 500, "source", [vid("x", 0, 1000), vid("y", 1000, 1500)], [1500, 3500]],
    ["no room before the next clip", photo, 0, "source", [vid("x", 10, 2000)], null],
    ["past D", photo, 24_000, "source", [], null],
    ["negative time clamps to 0", photo, -50, "source", [], [0, 2000]],
  ];
  it.each(cases)("%s", (_n, src, at, mode, existing, want) => {
    const out = insertClipAt(doc(existing), "t1", src, at, mode, { markersMs: markers });
    if (!want) return expect(out).toBeNull();
    const added = out?.project.tracks[0]?.clips.find((c) => c.id === out.clip.id);
    expect([added?.startMs, added?.endMs]).toEqual(want);
  });

  it("video fill-next never exceeds the source length", () => {
    const out = insertClipAt(doc([]), "t1", { kind: "video", path: "/s.mp4", durationMs: 600 }, 0, "fill-next", { markersMs: [4000] });
    expect(out?.clip.endMs).toBe(600);
  });
  it("colour clips carry the colour and no path", () => {
    const out = insertClipAt(doc([]), "t1", { kind: "color", color: "#112233" }, 0, "source");
    expect(out?.clip).toMatchObject({ kind: "color", color: "#112233", path: "" });
  });
  it("refuses locked, missing and adjustment tracks", () => {
    expect(insertClip(doc([]), "nope", photo, 0, "source")).toBeNull();
    expect(insertClip(doc([]), "t2", photo, 0, "source")).toBeNull();
    const locked = doc([]);
    locked.tracks[0] = { ...(locked.tracks[0] as NormalProject["tracks"][number]), locked: true };
    expect(insertClip(locked, "t1", photo, 0, "source")).toBeNull();
  });
  it("adjustment clips go on adjustment tracks only", () => {
    const d = doc([]);
    expect(insertAdjustClip(d, "t1", 0)).toBeNull();
    const out = insertAdjustClip(d, "t2", 500, { markersMs: [1500] });
    expect(out?.clip).toMatchObject({ kind: "adjust", startMs: 500, endMs: 1500 });
  });
  it("does not mutate the input", () => {
    const d = doc([]);
    const before = JSON.stringify(d);
    insertClip(d, "t1", photo, 0, "source");
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("moveClips", () => {
  const base = () => doc([vid("a", 0, 1000), vid("b", 2000, 3000), vid("c", 5000, 6000)]);
  it("moves a clip and keeps order", () => {
    expect(spans(moveClips(base(), ["a"], 1000))).toEqual([[1000, 2000], [2000, 3000], [5000, 6000]]);
  });
  it("moves a group keeping relative timing", () => {
    expect(spans(moveClips(base(), ["a", "b"], 500))).toEqual([[500, 1500], [2500, 3500], [5000, 6000]]);
  });
  it("is blocked by an overlap", () => {
    expect(moveClips(base(), ["a"], 1500)).toBeNull();
  });
  it("is blocked when a group member would overlap an unmoved clip", () => {
    expect(moveClips(base(), ["a", "b"], 2500)).toBeNull();
  });
  it("clamps at 0", () => {
    expect(spans(moveClips(doc([vid("b", 2000, 3000)]), ["b"], -5000))).toEqual([[0, 1000]]);
    expect(moveClips(base(), ["a"], -300)).toBeNull();
  });
  it("returns null for no movement", () => {
    expect(moveClips(base(), ["a"], 0)).toBeNull();
    expect(moveClips(base(), [], 100)).toBeNull();
  });
  it("moves across tracks only to compatible, unlocked tracks", () => {
    const d = doc([vid("a", 0, 1000)]);
    expect(moveClips(d, ["a"], 0, "t2")).toBeNull(); // adjust track
    const d2 = { ...d, tracks: [...d.tracks, { id: "t3", kind: "video", name: "Video 2", muted: false, locked: false, clips: [] }] } as NormalProject;
    const out = moveClips(d2, ["a"], 100, "t3");
    expect(out?.tracks[0]?.clips).toHaveLength(0);
    expect(spans(out, 2)).toEqual([[100, 1100]]);
    const locked = { ...d2, tracks: d2.tracks.map((t) => (t.id === "t3" ? { ...t, locked: true } : t)) } as NormalProject;
    expect(moveClips(locked, ["a"], 100, "t3")).toBeNull();
  });
  it("clears auto on moved clips", () => {
    const d = doc([vid("a", 0, 1000, { auto: true })]);
    expect(clipsOf(moveClips(d, ["a"], 100))[0]?.auto).toBe(false);
  });
  it("won't touch a locked track", () => {
    const d = base();
    d.tracks[0] = { ...(d.tracks[0] as NormalProject["tracks"][number]), locked: true };
    expect(moveClips(d, ["a"], 100)).toBeNull();
  });
});

describe("trimClip", () => {
  it("moves the end edge, at least one frame, not into a neighbour", () => {
    const d = doc([vid("a", 1000, 2000), vid("b", 3000, 4000)]);
    expect(spans(trimClip(d, "a", "end", 2500))[0]).toEqual([1000, 2500]);
    expect(spans(trimClip(d, "a", "end", 3500))[0]).toEqual([1000, 3000]);
    expect(spans(trimClip(d, "a", "end", 0))[0]).toEqual([1000, 1034]);
    expect(trimClip(d, "a", "end", 2000)).toBeNull();
  });
  it("start edge advances InMs at speed 1", () => {
    const d = doc([vid("a", 1000, 3000, { inMs: 500 })]);
    const c = clipsOf(trimClip(d, "a", "start", 1400))[0];
    expect([c?.startMs, c?.inMs, c?.endMs]).toEqual([1400, 900, 3000]);
  });
  it("start edge is speed-aware", () => {
    const d = doc([vid("a", 1000, 3000, { inMs: 0, speed: "0.5" })]);
    const c = clipsOf(trimClip(d, "a", "start", 2000))[0];
    expect(c?.inMs).toBe(500);
  });
  it("extending the start left moves InMs back and stops at InMs 0", () => {
    const d = doc([vid("a", 1000, 3000, { inMs: 300 })]);
    const c = clipsOf(trimClip(d, "a", "start", 500))[0];
    expect([c?.startMs, c?.inMs]).toEqual([700, 0]);
  });
  it("start edge is limited by the previous clip and by one frame", () => {
    const d = doc([vid("p", 0, 800), vid("a", 1000, 2000, { inMs: 5000 })]);
    expect(clipsOf(trimClip(d, "a", "start", 100))[1]?.startMs).toBe(800);
    expect(clipsOf(trimClip(d, "a", "start", 5000))[1]?.startMs).toBe(2000 - 34);
  });
  it("end edge stops at the end of the source (video, speed-aware)", () => {
    const d = doc([vid("a", 0, 1000, { inMs: 2000 })]);
    expect(clipsOf(trimClip(d, "a", "end", 9000, { sourceMs: 5000 }))[0]?.endMs).toBe(3000);
    const slow = doc([vid("a", 0, 1000, { inMs: 2000, speed: "0.5" })]);
    expect(clipsOf(trimClip(slow, "a", "end", 9000, { sourceMs: 5000 }))[0]?.endMs).toBe(6000);
  });
  it("images ignore the source end and keep InMs", () => {
    const d = doc([newClip({ id: "p", kind: "image", path: "/p.jpg", startMs: 0, endMs: 1000 })]);
    const c = clipsOf(trimClip(d, "p", "end", 9000, { sourceMs: 100 }))[0];
    expect(c?.endMs).toBe(9000);
    expect(clipsOf(trimClip(d, "p", "start", 400))[0]?.inMs).toBe(0);
  });
  it("re-bases keyframes when the start moves", () => {
    const tr = JSON.stringify({ x: 0, y: 0, scale: { base: 1, keys: [{ t: 1000, v: 1, ease: "linear" }, { t: 2000, v: 2, ease: "linear" }] }, rotation: 0, opacity: 1 });
    const d = doc([vid("a", 0, 3000, { transform: tr })]);
    const t = JSON.parse(clipsOf(trimClip(d, "a", "start", 1000))[0]?.transform ?? "{}") as { scale: { keys: Array<{ t: number }> } };
    expect(t.scale.keys.map((k) => k.t)).toEqual([0, 1000]);
  });
  it("won't edit a locked track", () => {
    const d = doc([vid("a", 0, 1000)]);
    d.tracks[0] = { ...(d.tracks[0] as NormalProject["tracks"][number]), locked: true };
    expect(trimClip(d, "a", "end", 500)).toBeNull();
  });
});

describe("splitAt", () => {
  it("splits one clip: new id, InMs advanced, clean transition on the right", () => {
    const d = doc([vid("a", 1000, 3000, { inMs: 500, in: JSON.stringify({ kind: "flash", ms: 200 }), auto: true })]);
    const out = clipsOf(splitAt(d, ["a"], 2000));
    expect(out).toHaveLength(2);
    expect([out[0]?.id, out[0]?.startMs, out[0]?.endMs, out[0]?.inMs, out[0]?.auto]).toEqual(["a", 1000, 2000, 500, false]);
    expect([out[1]?.startMs, out[1]?.endMs, out[1]?.inMs, out[1]?.in]).toEqual([2000, 3000, 1500, ""]);
    expect(out[1]?.id).not.toBe("a");
    expect(out[0]?.in).not.toBe("");
  });
  it("is speed-aware", () => {
    const d = doc([vid("a", 0, 2000, { inMs: 0, speed: "2" })]);
    expect(clipsOf(splitAt(d, ["a"], 500))[1]?.inMs).toBe(1000);
  });
  it("shares the matte and re-bases keys", () => {
    const matte = { mode: "people", id: "m1", fromMs: 0, toMs: 5000, clicks: null } as unknown as EditClip["matte"];
    const tr = JSON.stringify({ x: 0, y: 0, scale: { base: 1, keys: [{ t: 1500, v: 1, ease: "linear" }, { t: 2000, v: 2, ease: "linear" }] }, rotation: 0, opacity: 1 });
    const d = doc([vid("a", 0, 3000, { matte, transform: tr })]);
    const out = clipsOf(splitAt(d, ["a"], 1000));
    expect(out[0]?.matte).toBe(out[1]?.matte);
    const t = JSON.parse(out[1]?.transform ?? "{}") as { scale: { keys: Array<{ t: number }> } };
    expect(t.scale.keys.map((k) => k.t)).toEqual([0, 500, 1000]);
    expect(t.scale.keys[0]?.t).toBe(0);
    expect(t.scale.keys.at(-1)?.t).toBe(1000);
  });
  it("skips clips not under the cut and cuts that leave less than a frame", () => {
    const d = doc([vid("a", 0, 1000), vid("b", 2000, 3000)]);
    expect(splitAt(d, ["a"], 1500)).toBeNull();
    expect(splitAt(d, ["a"], 10)).toBeNull();
    expect(splitAt(d, ["a"], 990)).toBeNull();
    expect(spans(splitAt(d, ["a", "b"], 500))).toEqual([[0, 500], [500, 1000], [2000, 3000]]);
  });
});

describe("sliceAtMarkers", () => {
  const marks = [1000, 2000, 3000, 4000];
  it("cuts a clip at every marker inside it", () => {
    const d = doc([vid("a", 500, 3500)]);
    expect(spans(sliceAtMarkers(d, ["a"], marks, false))).toEqual([[500, 1000], [1000, 2000], [2000, 3000], [3000, 3500]]);
  });
  it("ignores markers within a frame of an edge and between close markers", () => {
    const d = doc([vid("a", 0, 2010)]);
    expect(spans(sliceAtMarkers(d, ["a"], [10, 1000, 1010, 2000], false))).toEqual([[0, 1000], [1000, 2010]]);
  });
  it("a range slices only inside it", () => {
    const d = doc([vid("a", 0, 6000)]);
    expect(spans(sliceAtMarkers(d, { fromMs: 1500, toMs: 3500 }, marks, false))).toEqual([[0, 2000], [2000, 3000], [3000, 6000]]);
  });
  it("returns null with nothing to cut", () => {
    expect(sliceAtMarkers(doc([vid("a", 0, 500)]), ["a"], marks, false)).toBeNull();
  });
  it("cycles sources: slice k takes the next source, videos continue from their cursor", () => {
    const d = doc([vid("a", 0, 3000, { path: "/s1.mp4" })], {
      sources: [
        { path: "/s1.mp4", tags: [] },
        { path: "/s2.mp4", tags: [] },
        { path: "/p.jpg", tags: [] },
      ],
    });
    const out = clipsOf(
      sliceAtMarkers(d, ["a"], [1000, 2000], true, {
        sources: { "/s1.mp4": { kind: "video", durationMs: 60_000 }, "/s2.mp4": { kind: "video", durationMs: 1500 }, "/p.jpg": { kind: "image", durationMs: 0 } },
      }),
    );
    expect(out.map((c) => c.path)).toEqual(["/s1.mp4", "/s2.mp4", "/p.jpg"]);
    expect(out[1]?.inMs).toBe(0);
    expect(out[2]).toMatchObject({ kind: "image", inMs: 0 });
  });
  it("wraps a cursor to 0 when the rest is shorter than the slice", () => {
    const d = doc([vid("a", 0, 2000, { path: "/s1.mp4" }), vid("z", 5000, 5800, { path: "/s2.mp4", inMs: 0 })], {
      sources: [
        { path: "/s1.mp4", tags: [] },
        { path: "/s2.mp4", tags: [] },
      ],
    });
    const out = clipsOf(sliceAtMarkers(d, ["a"], [1000], true, { sources: { "/s1.mp4": { kind: "video", durationMs: 9000 }, "/s2.mp4": { kind: "video", durationMs: 1500 } } }));
    expect(out[1]?.path).toBe("/s2.mp4");
    expect(out[1]?.inMs).toBe(0); // cursor 800 + 1000 > 1500
  });
});

describe("delete and duplicate", () => {
  it("deletes", () => {
    const d = doc([vid("a", 0, 1000), vid("b", 2000, 3000)]);
    expect(spans(deleteClips(d, ["a"]))).toEqual([[2000, 3000]]);
    expect(deleteClips(d, ["zzz"])).toBeNull();
  });
  it("duplicates to the right of the selection with new ids", () => {
    const d = doc([vid("a", 0, 1000), vid("b", 1000, 2000)]);
    const out = duplicateClips(d, ["a", "b"]);
    expect(spans(out)).toEqual([[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000]]);
    expect(new Set(clipsOf(out).map((c) => c.id)).size).toBe(4);
  });
  it("skips past clips in the way", () => {
    const d = doc([vid("a", 0, 1000), vid("b", 1000, 3000)]);
    expect(spans(duplicateClips(d, ["a"]))).toEqual([[0, 1000], [1000, 3000], [3000, 4000]]);
  });
  it("alt-drag copies by a delta", () => {
    const d = doc([vid("a", 0, 1000)]);
    expect(spans(duplicateClips(d, ["a"], 5000))).toEqual([[0, 1000], [5000, 6000]]);
    expect(duplicateClips(d, ["a"], 500)).toBeNull();
  });
});

describe("tracks", () => {
  it("adds up to 8 and names by kind", () => {
    let d: NormalProject | null = doc([]);
    d = addTrack(d, "video");
    expect(d?.tracks.at(-1)?.name).toBe("Video 2");
    d = addTrack(d as NormalProject, "adjust");
    expect(d?.tracks.at(-1)?.name).toBe("Adjust 2");
    for (let i = 0; i < 4; i++) d = addTrack(d as NormalProject, "video");
    expect(d?.tracks).toHaveLength(8);
    expect(addTrack(d as NormalProject, "video")).toBeNull();
  });
  it("removes but keeps one", () => {
    const d = doc([]);
    expect(removeTrack(d, "t2")?.tracks.map((t) => t.id)).toEqual(["t1"]);
    expect(removeTrack(removeTrack(d, "t2") as NormalProject, "t1")).toBeNull();
    expect(removeTrack(d, "nope")).toBeNull();
  });
  it("reorders", () => {
    expect(reorderTrack(doc([]), "t1", 1)?.tracks.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(reorderTrack(doc([]), "t1", 0)).toBeNull();
  });
  it("renames, mutes, locks", () => {
    const d = doc([]);
    expect(renameTrack(d, "t1", "  Main ")?.tracks[0]?.name).toBe("Main");
    expect(renameTrack(d, "t1", " ")).toBeNull();
    expect(setTrackMuted(d, "t1", true)?.tracks[0]?.muted).toBe(true);
    expect(setTrackMuted(d, "t1", false)).toBeNull();
    expect(setTrackLocked(d, "t1", true)?.tracks[0]?.locked).toBe(true);
  });
  it("changes kind only when empty", () => {
    expect(setTrackKind(doc([]), "t1", "adjust")?.tracks[0]?.kind).toBe("adjust");
    expect(setTrackKind(doc([vid("a", 0, 1000)]), "t1", "adjust")).toBeNull();
  });
});

describe("neighbourMarker", () => {
  it("finds the previous and next marker", () => {
    const m = [100, 500, 900];
    expect(neighbourMarker(m, 500, 1)).toBe(900);
    expect(neighbourMarker(m, 500, -1)).toBe(100);
    expect(neighbourMarker(m, 900, 1)).toBeNull();
    expect(neighbourMarker(m, 50, -1)).toBeNull();
  });
});
