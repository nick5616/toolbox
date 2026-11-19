import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { newClip } from "@/editor/doc";
import {
  canDetachAudio,
  closeGap,
  copyClips,
  cutAt,
  detachAudio,
  editPoints,
  gapAt,
  insertAudioClipAt,
  linkClips,
  pasteClips,
  rippleDelete,
  rippleTrim,
  rollEdit,
  slipClip,
  toggleLink,
  unlinkClips,
} from "./edit";
import { addTrack, applyPlacement, clipFitsTrack, cutRange, duplicateClips, moveClips, openGap, overwriteRange, setTrackHeight, setTrackSolo, splitAt, trackHeightOf, withLinked } from "./ops";

const vid = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "video", path: "/a.mp4", startMs, endMs, volume: 1, ...over });
const aud = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "audio", path: "/a.mp4", startMs, endMs, volume: 1, ...over });

/** A 24 s, 30 fps edit: t1 (video) holds `clips`, t2 (adjust) is empty, a1 (audio, at the bottom) holds `audio`. */
function doc(clips: EditClip[], audio: EditClip[] = [], extra: Partial<NormalProject> = {}): NormalProject {
  const p = normalizeProject(fixtureProject());
  return {
    ...p,
    tracks: [
      { id: "a1", kind: "audio", name: "Audio 1", muted: false, locked: false, matte: "", clips: audio },
      { ...(p.tracks[0] as NormalProject["tracks"][number]), clips },
      { ...(p.tracks[1] as NormalProject["tracks"][number]), clips: [] },
    ],
    ...extra,
  };
}
const t1 = (p: NormalProject | null, id = "t1"): EditClip[] => (p?.tracks.find((t) => t.id === id)?.clips ?? []).slice().sort((a, b) => a.startMs - b.startMs);
const spans = (p: NormalProject | null, id = "t1"): Array<[number, number]> => t1(p, id).map((c) => [c.startMs, c.endMs]);
const lock = (p: NormalProject, id: string): NormalProject => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, locked: true } : t)) });

describe("overwrite", () => {
  const clips = () => [vid("a", 0, 1000), vid("b", 1000, 3000), vid("c", 3000, 4000)];

  it("cutRange trims both neighbours and removes what is covered", () => {
    const out = cutRange(clips(), 500, 3500, 30, new Map());
    expect(out.clips.map((c) => [c.id, c.startMs, c.endMs])).toEqual([["a", 0, 500], ["c", 3500, 4000]]);
    expect(out.touched.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("splits a clip around the range in two, advancing the right half's source in-point", () => {
    const out = cutRange([vid("a", 0, 4000, { inMs: 1000 })], 1000, 2000, 30, new Map());
    expect(out.clips.map((c) => [c.startMs, c.endMs, c.inMs])).toEqual([[0, 1000, 1000], [2000, 4000, 3000]]);
    expect(new Set(out.clips.map((c) => c.id)).size).toBe(2);
  });

  it("drops slivers shorter than a frame", () => {
    const out = cutRange([vid("a", 0, 1000)], 10, 2000, 30, new Map());
    expect(out.clips).toEqual([]);
  });

  it("overwriteRange changes only the one track", () => {
    const d = doc(clips());
    const out = overwriteRange(d, 1, 500, 1500);
    expect(spans(out)).toEqual([[0, 500], [1500, 3000], [3000, 4000]]);
    expect(out.tracks[0]).toBe(d.tracks[0]);
  });

  it("an overwrite that splits a linked clip splits its partner too, with fresh links on the right halves", () => {
    const d = doc([vid("v", 0, 4000, { link: "L" })], [aud("s", 0, 4000, { link: "L" })]);
    const out = overwriteRange(d, 1, 1000, 2000);
    expect(spans(out)).toEqual([[0, 1000], [2000, 4000]]);
    expect(spans(out, "a1")).toEqual([[0, 1000], [2000, 4000]]);
    const links = [...t1(out), ...t1(out, "a1")].map((c) => c.link);
    expect(links.filter((l) => l === "L")).toHaveLength(2);
    const fresh = links.filter((l) => l && l !== "L");
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toBe(fresh[1]);
  });

  it("a locked partner track is left alone", () => {
    const d = lock(doc([vid("v", 0, 4000, { link: "L" })], [aud("s", 0, 4000, { link: "L" })]), "a1");
    const out = overwriteRange(d, 1, 1000, 2000);
    expect(spans(out, "a1")).toEqual([[0, 4000]]);
  });

  it("applyPlacement in insert mode opens a gap and shifts what follows", () => {
    const d = doc(clips());
    const placed = [{ clip: vid("n", 1500, 2500), trackIndex: 1 }];
    const out = applyPlacement(d, new Set(), placed, "insert");
    expect(spans(out)).toEqual([[0, 1000], [1000, 1500], [1500, 2500], [2500, 4000], [4000, 5000]]);
  });

  it("openGap keeps the right half's keys relative to its new start", () => {
    const keyed = vid("k", 0, 2000, { transform: JSON.stringify({ x: { base: 0, keys: [{ t: 0, v: 0, ease: "linear" }, { t: 2000, v: 1, ease: "linear" }] } }) });
    const out = openGap([keyed], 1000, 500, 30, new Map());
    expect(out.map((c) => [c.startMs, c.endMs])).toEqual([[0, 1000], [1500, 2500]]);
    const right = out[1] as EditClip;
    expect(JSON.parse(right.transform).x.keys[0]).toMatchObject({ t: 0 });
  });

  it("moving onto a locked track is refused", () => {
    const d = lock(doc([vid("a", 0, 1000)]), "t1");
    expect(moveClips(d, ["a"], 500)).toBeNull();
  });

  it("audio clips only go on audio tracks and the other way round", () => {
    const d = doc([vid("a", 0, 1000)], [aud("s", 2000, 3000)]);
    expect(moveClips(d, ["s"], 0, "t1")).toBeNull();
    expect(moveClips(d, ["a"], 0, "a1")).toBeNull();
    expect(spans(moveClips(d, ["s"], 500), "a1")).toEqual([[2500, 3500]]);
    expect(clipFitsTrack(aud("x", 0, 1), { kind: "audio" })).toBe(true);
    expect(clipFitsTrack(vid("x", 0, 1), { kind: "audio" })).toBe(false);
  });

  it("alt-drag copies overwrite too and never touch the original", () => {
    const d = doc([vid("a", 0, 1000), vid("b", 1000, 3000)]);
    const out = duplicateClips(d, ["a"], 500);
    expect(spans(out)).toEqual([[0, 500], [500, 1500], [1500, 3000]]);
  });
});

describe("ripple delete and gaps", () => {
  const base = () => doc([vid("a", 0, 1000), vid("b", 1000, 3000), vid("c", 3500, 4000)], [aud("s", 3500, 5000)]);

  it("ripple delete closes the space on the same track", () => {
    expect(spans(rippleDelete(base(), ["b"]))).toEqual([[0, 1000], [1500, 2000]]);
  });
  it("two deletions shift later clips by both", () => {
    expect(spans(rippleDelete(base(), ["a", "b"]))).toEqual([[500, 1000]]);
  });
  it("other tracks keep their clips", () => {
    expect(spans(rippleDelete(base(), ["b"]), "a1")).toEqual([[3500, 5000]]);
  });
  it("locked tracks are untouched", () => {
    expect(rippleDelete(lock(base(), "t1"), ["b"])).toBeNull();
  });
  it("is null when nothing matches", () => {
    expect(rippleDelete(base(), ["nope"])).toBeNull();
  });

  it("gapAt finds the empty stretch (and not clips or the tail)", () => {
    const d = base();
    expect(gapAt(d, "t1", 3200)).toEqual({ trackId: "t1", fromMs: 3000, toMs: 3500 });
    expect(gapAt(d, "t1", 500)).toBeNull();
    expect(gapAt(d, "t1", 4500)).toBeNull();
    expect(gapAt(doc([vid("a", 1000, 2000)]), "t1", 200)).toEqual({ trackId: "t1", fromMs: 0, toMs: 1000 });
  });

  it("closeGap moves everything after the gap left", () => {
    const d = base();
    const g = gapAt(d, "t1", 3200);
    expect(spans(closeGap(d, g as NonNullable<typeof g>))).toEqual([[0, 1000], [1000, 3000], [3000, 3500]]);
  });
  it("closeGap refuses a locked track and a gap with nothing after it", () => {
    const d = base();
    expect(closeGap(lock(d, "t1"), { trackId: "t1", fromMs: 3000, toMs: 3500 })).toBeNull();
    expect(closeGap(d, { trackId: "t1", fromMs: 4000, toMs: 6000 })).toBeNull();
  });
});

describe("ripple trim", () => {
  const base = () => doc([vid("a", 0, 1000), vid("b", 1000, 3000, { inMs: 500 }), vid("c", 3500, 4000)]);

  it("the end edge shifts later clips by the change", () => {
    expect(spans(rippleTrim(base(), "b", "end", 2000))).toEqual([[0, 1000], [1000, 2000], [2500, 3000]]);
  });
  it("lengthening shifts them right (nothing blocks it)", () => {
    expect(spans(rippleTrim(base(), "b", "end", 3800))).toEqual([[0, 1000], [1000, 3800], [4300, 4800]]);
  });
  it("the start edge keeps the clip in place and moves the in-point; later clips shift", () => {
    const out = rippleTrim(base(), "b", "start", 1500);
    expect(spans(out)).toEqual([[0, 1000], [1000, 2500], [3000, 3500]]);
    expect(t1(out)[1]?.inMs).toBe(1000);
  });
  it("extending the head is limited by the source start", () => {
    // inMs 500: the head can come back 500 ms.
    const out = rippleTrim(base(), "b", "start", 0);
    expect(spans(out)).toEqual([[0, 1000], [1000, 3500], [4000, 4500]]);
    expect(t1(out)[1]?.inMs).toBe(0);
  });
  it("is null for a locked track and for no change", () => {
    expect(rippleTrim(lock(base(), "t1"), "b", "end", 2000)).toBeNull();
    expect(rippleTrim(base(), "b", "end", 3000)).toBeNull();
  });
});

describe("roll", () => {
  const base = () => doc([vid("a", 0, 2000), vid("b", 2000, 5000, { inMs: 1000 })]);

  it("moves the cut: one clip grows, the other shrinks", () => {
    const out = rollEdit(base(), "a", "b", 2500);
    expect(spans(out)).toEqual([[0, 2500], [2500, 5000]]);
    expect(t1(out)[1]?.inMs).toBe(1500);
  });
  it("rolling back extends the right clip's head", () => {
    const out = rollEdit(base(), "a", "b", 1500);
    expect(spans(out)).toEqual([[0, 1500], [1500, 5000]]);
    expect(t1(out)[1]?.inMs).toBe(500);
  });
  it("stops where the right clip runs out of source before its in-point", () => {
    const out = rollEdit(base(), "a", "b", 500);
    expect(spans(out)).toEqual([[0, 1000], [1000, 5000]]);
    expect(t1(out)[1]?.inMs).toBe(0);
  });
  it("stops where the left source ends", () => {
    const out = rollEdit(base(), "a", "b", 4000, { leftSourceMs: 3000 });
    expect(spans(out)).toEqual([[0, 3000], [3000, 5000]]);
  });
  it("keeps one frame in each clip", () => {
    const out = rollEdit(base(), "a", "b", 4999);
    expect(t1(out)[1]?.endMs).toBe(5000);
    expect((t1(out)[1]?.endMs ?? 0) - (t1(out)[1]?.startMs ?? 0)).toBeGreaterThanOrEqual(34);
  });
  it("refuses clips that don't touch, locked tracks and no movement", () => {
    expect(rollEdit(doc([vid("a", 0, 1000), vid("b", 1500, 3000)]), "a", "b", 1200)).toBeNull();
    expect(rollEdit(lock(base(), "t1"), "a", "b", 2500)).toBeNull();
    expect(rollEdit(base(), "a", "b", 2000)).toBeNull();
  });
  it("cutAt finds the touching pair near a time", () => {
    const pair = cutAt(base(), "t1", 2001, 4);
    expect(pair?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cutAt(base(), "t1", 900, 4)).toBeNull();
  });
});

describe("slip", () => {
  const base = () => doc([vid("a", 1000, 3000, { inMs: 1000 })]);

  it("shifts the in-point without moving the clip", () => {
    const out = slipClip(base(), "a", 500, { sourceMs: 10_000 });
    expect(t1(out)[0]).toMatchObject({ startMs: 1000, endMs: 3000, inMs: 1500 });
  });
  it("never goes before the start of the file", () => {
    expect(t1(slipClip(base(), "a", -5000))[0]?.inMs).toBe(0);
  });
  it("never goes past the end of the file", () => {
    // The clip uses 2000 ms; a 5000 ms file allows an in-point up to 3000.
    expect(t1(slipClip(base(), "a", 9000, { sourceMs: 5000 }))[0]?.inMs).toBe(3000);
  });
  it("is null when nothing changes, for photos and for locked tracks", () => {
    expect(slipClip(base(), "a", 0)).toBeNull();
    expect(slipClip(doc([newClip({ id: "p", kind: "image", path: "/p.jpg", startMs: 0, endMs: 1000 })]), "p", 100)).toBeNull();
    expect(slipClip(lock(base(), "t1"), "a", 100)).toBeNull();
  });
  it("works for audio clips", () => {
    expect(t1(slipClip(doc([], [aud("s", 0, 1000, { inMs: 200 })]), "s", 300), "a1")[0]?.inMs).toBe(500);
  });
});

describe("clipboard", () => {
  const base = () => doc([vid("a", 1000, 2000), vid("b", 4000, 5000)], [aud("s", 1000, 2000)]);

  it("copies and pastes at a time on the same track (overwrite)", () => {
    const d = base();
    const data = copyClips(d, ["a"]);
    const res = pasteClips(d, data as NonNullable<typeof data>, 4500, undefined, "overwrite");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(spans(res.project)).toEqual([[1000, 2000], [4000, 4500], [4500, 5500]]);
      expect(res.ids).toHaveLength(1);
      expect(t1(res.project).find((c) => c.id === res.ids[0])).toMatchObject({ startMs: 4500, endMs: 5500 });
    }
  });

  it("paste as insert pushes the later clips right", () => {
    const d = base();
    const data = copyClips(d, ["a"]);
    const res = pasteClips(d, data as NonNullable<typeof data>, 3000, undefined, "insert");
    expect(res.ok && spans(res.project)).toEqual([[1000, 2000], [3000, 4000], [5000, 6000]]);
  });

  it("a group keeps its relative timing and track offset; linked copies stay linked to each other", () => {
    const d = doc([vid("v", 1000, 2000, { link: "L" })], [aud("s", 1000, 2000, { link: "L" })]);
    const data = copyClips(d, ["v", "s"]);
    const res = pasteClips(d, data as NonNullable<typeof data>, 5000, undefined, "overwrite");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v2 = t1(res.project)[1] as EditClip;
      const s2 = t1(res.project, "a1")[1] as EditClip;
      expect([v2.startMs, s2.startMs]).toEqual([5000, 5000]);
      expect(v2.link).toBeTruthy();
      expect(v2.link).toBe(s2.link);
      expect(v2.link).not.toBe("L");
    }
  });

  it("pastes onto another track of the right kind", () => {
    const d = doc([vid("a", 1000, 2000)], [aud("s", 0, 500)]);
    const data = copyClips(d, ["s"]);
    const d2 = addTrack(d, "audio") as NormalProject;
    const target = d2.tracks[0]?.id as string;
    const res = pasteClips(d2, data as NonNullable<typeof data>, 3000, target, "overwrite");
    expect(res.ok && spans(res.project, target)).toEqual([[3000, 3500]]);
  });

  it("refuses a locked target and the wrong kind of track", () => {
    const d = base();
    const data = copyClips(d, ["a"]) as NonNullable<ReturnType<typeof copyClips>>;
    expect(pasteClips(lock(d, "t1"), data, 3000, undefined, "overwrite")).toEqual({ ok: false, reason: "locked" });
    expect(pasteClips(d, data, 3000, "a1", "overwrite")).toEqual({ ok: false, reason: "incompatible" });
    expect(pasteClips(d, { entries: [], anchorMs: 0, refTrackId: "t1" }, 0, undefined, "overwrite")).toEqual({ ok: false, reason: "empty" });
  });

  it("copyClips is null for unknown ids", () => {
    expect(copyClips(base(), ["zzz"])).toBeNull();
  });
});

describe("links", () => {
  const base = () => doc([vid("a", 0, 1000), vid("b", 2000, 3000)], [aud("s", 0, 1000)]);

  it("links two or more clips, never on a locked track", () => {
    const out = linkClips(base(), ["a", "s"]);
    expect(t1(out)[0]?.link).toBeTruthy();
    expect(t1(out)[0]?.link).toBe(t1(out, "a1")[0]?.link);
    expect(linkClips(base(), ["a"])).toBeNull();
    expect(linkClips(lock(base(), "a1"), ["a", "s"])).toBeNull();
  });
  it("unlinks", () => {
    const linked = linkClips(base(), ["a", "s"]) as NormalProject;
    const out = unlinkClips(linked, ["a", "s"]);
    expect(t1(out)[0]?.link).toBeUndefined();
    expect(unlinkClips(base(), ["a"])).toBeNull();
  });
  it("toggle links, then unlinks", () => {
    const linked = toggleLink(base(), ["a", "s"]) as NormalProject;
    expect(t1(linked)[0]?.link).toBeTruthy();
    expect(t1(toggleLink(linked, ["a", "s"]))[0]?.link).toBeUndefined();
  });
  it("withLinked adds the partners", () => {
    const linked = linkClips(base(), ["a", "s"]) as NormalProject;
    expect(withLinked(linked, ["a"]).sort()).toEqual(["a", "s"]);
    expect(withLinked(linked, ["b"])).toEqual(["b"]);
  });

  describe("razor on linked clips", () => {
    const pair = () => doc([vid("v", 0, 4000, { link: "L" })], [aud("s", 0, 4000, { link: "L" })]);

    it("a razor cut splits both and keeps each pair linked", () => {
      const out = splitAt(pair(), ["v"], 1000, { linked: true });
      expect(spans(out)).toEqual([[0, 1000], [1000, 4000]]);
      expect(spans(out, "a1")).toEqual([[0, 1000], [1000, 4000]]);
      const [vl, vr] = t1(out) as [EditClip, EditClip];
      const [sl, sr] = t1(out, "a1") as [EditClip, EditClip];
      expect(vl.link).toBe("L");
      expect(sl.link).toBe("L");
      expect(vr.link).toBeTruthy();
      expect(vr.link).toBe(sr.link);
      expect(vr.link).not.toBe("L");
    });

    it("without `linked` only the listed clip splits (its right half unlinked)", () => {
      const out = splitAt(pair(), ["v"], 1000);
      expect(spans(out)).toEqual([[0, 1000], [1000, 4000]]);
      expect(spans(out, "a1")).toEqual([[0, 4000]]);
      expect(t1(out)[1]?.link).toBeUndefined();
    });

    it("a locked partner track isn't split and the right half is unlinked", () => {
      const out = splitAt(lock(pair(), "a1"), ["v"], 1000, { linked: true });
      expect(spans(out, "a1")).toEqual([[0, 4000]]);
      expect(t1(out)[1]?.link).toBeUndefined();
    });

    it("locked tracks never change", () => {
      expect(splitAt(lock(pair(), "t1"), ["v"], 1000)).toBeNull();
    });
  });

  describe("detach audio", () => {
    it("makes a linked audio clip with the same timing, in-point and speed; the video goes silent", () => {
      const d = doc([vid("v", 1000, 3000, { inMs: 700, speed: "2", volume: 0.8 })], [aud("x", 5000, 6000)]);
      const out = detachAudio(d, "v");
      expect(out).not.toBeNull();
      const v = t1(out?.project ?? null)[0] as EditClip;
      const a = t1(out?.project ?? null, "a1").find((c) => c.id === out?.audioId) as EditClip;
      expect(v.volume).toBe(0);
      expect(a).toMatchObject({ kind: "audio", path: "/a.mp4", startMs: 1000, endMs: 3000, inMs: 700, speed: "2", volume: 0.8 });
      expect(v.link).toBeTruthy();
      expect(v.link).toBe(a.link);
    });
    it("uses the first free audio track and makes one when none has room", () => {
      const busy = doc([vid("v", 0, 2000)], [aud("x", 500, 1500)]);
      const out = detachAudio(busy, "v");
      expect(out?.project.tracks).toHaveLength(4);
      expect(out?.project.tracks[0]?.kind).toBe("audio");
      expect(t1(out?.project ?? null, out?.project.tracks[0]?.id)).toHaveLength(1);
      const none = doc([vid("v", 0, 2000)]);
      const noAudio = { ...none, tracks: none.tracks.filter((t) => t.kind !== "audio") };
      expect(detachAudio(noAudio, "v")?.project.tracks.filter((t) => t.kind === "audio")).toHaveLength(1);
    });
    it("takes the audio track nearest the video first", () => {
      const d = addTrack(doc([vid("v", 0, 2000)]), "audio") as NormalProject; // audio tracks: [Audio 2, Audio 1]
      const out = detachAudio(d, "v");
      expect(t1(out?.project ?? null, "a1")).toHaveLength(1);
    });
    it("refuses linked, locked and non-video clips", () => {
      expect(detachAudio(doc([vid("v", 0, 2000, { link: "L" })]), "v")).toBeNull();
      expect(detachAudio(lock(doc([vid("v", 0, 2000)]), "t1"), "v")).toBeNull();
      expect(detachAudio(doc([], [aud("s", 0, 1000)]), "s")).toBeNull();
      expect(canDetachAudio(doc([vid("v", 0, 2000)]), "v", false)).toBe(false);
      expect(canDetachAudio(doc([vid("v", 0, 2000)]), "v")).toBe(true);
    });
  });
});

describe("audio clips and tracks", () => {
  it("insertAudioClipAt puts the whole file on an audio track after what's under it", () => {
    const d = doc([], [aud("x", 0, 1000)]);
    const out = insertAudioClipAt(d, "a1", { path: "/m.mp3", durationMs: 3000 }, 500);
    expect(out?.clip).toMatchObject({ kind: "audio", path: "/m.mp3", startMs: 1000, endMs: 4000, volume: 1 });
  });
  it("a drop overwrites, or inserts", () => {
    const d = doc([], [aud("x", 0, 4000)]);
    expect(spans(insertAudioClipAt(d, "a1", { path: "/m.mp3", durationMs: 1000 }, 1000, "overwrite")?.project ?? null, "a1")).toEqual([[0, 1000], [1000, 2000], [2000, 4000]]);
    expect(spans(insertAudioClipAt(d, "a1", { path: "/m.mp3", durationMs: 1000 }, 1000, "insert")?.project ?? null, "a1")).toEqual([[0, 1000], [1000, 2000], [2000, 5000]]);
  });
  it("refuses video tracks, locked tracks and unknown lengths", () => {
    expect(insertAudioClipAt(doc([], []), "t1", { path: "/m.mp3", durationMs: 1000 }, 0)).toBeNull();
    expect(insertAudioClipAt(lock(doc([], []), "a1"), "a1", { path: "/m.mp3", durationMs: 1000 }, 0)).toBeNull();
    expect(insertAudioClipAt(doc([], []), "a1", { path: "/m.mp3", durationMs: 0 }, 0)).toBeNull();
  });
  it("addTrack('audio') puts the track at the bottom and names it", () => {
    const d = normalizeProject(fixtureProject());
    const out = addTrack(d, "audio") as NormalProject;
    expect(out.tracks[0]).toMatchObject({ kind: "audio", name: "Audio 1" });
    expect((addTrack(out, "audio") as NormalProject).tracks[0]?.name).toBe("Audio 2");
  });
  it("track heights and solo", () => {
    const d = doc([]);
    expect(trackHeightOf(d.tracks[1] as NormalProject["tracks"][number])).toBe("m");
    const tall = setTrackHeight(d, "t1", "l") as NormalProject;
    expect(trackHeightOf(tall.tracks[1] as NormalProject["tracks"][number])).toBe("l");
    expect(setTrackHeight(tall, "t1", "l")).toBeNull();
    const medium = setTrackHeight(tall, "t1", "m") as NormalProject;
    expect(medium.tracks[1]?.height).toBe("");
    expect(setTrackSolo(d, "a1", true)?.tracks[0]?.solo).toBe(true);
    expect(setTrackSolo(d, "a1", false)).toBeNull();
  });
});

describe("edit-point navigation", () => {
  it("lists every clip edge on every track, plus 0 and the end, ascending and unique", () => {
    const d = doc([vid("a", 1000, 2000), vid("b", 2000, 3500)], [aud("s", 500, 2500)]);
    expect(editPoints(d)).toEqual([0, 500, 1000, 2000, 2500, 3500, 24_000]);
  });
});
