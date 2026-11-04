import { describe, expect, it } from "vitest";
import type { EditClip, EditMoment } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureKicks, fixtureProject } from "@/viz/edit/fixture";
import { parseEffects, parseTransform, parseTransition } from "@/viz/edit/schema";
import type { Marker, MarkerLane } from "@/viz/edit/types";
import { newClip } from "@/editor/doc";
import { validateShape } from "../autofill/autofill";
import type { AutofillSource } from "../autofill/types";
import { DEFAULT_SETTINGS, STYLE_TRACK_NAME, clearAdjustRange, cutDensity, planStyle, rangeFromContext, resolveHitLane, snapToGrid, styleEffects, type StyleSettings } from "./styleLogic";

const analysis = buildEditFixture();
const mk = (lane: MarkerLane, ms: number, extra: Partial<Marker> = {}): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1, ...extra });

function markers(): Marker[] {
  const out: Marker[] = [];
  for (let t = 0; t < 24_000; t += 500) out.push(mk("beat", t));
  for (let t = 0; t < 24_000; t += 250) out.push(mk("hats", t));
  for (let t = 0; t < 24_000; t += 2000) out.push(mk("downbeat", t));
  for (const t of fixtureKicks()) out.push(mk("kick", t));
  for (const t of [3500, 9000, 17_000]) out.push(mk("accent", t));
  for (const s of analysis.audio.sections) out.push(mk("section", s.startMs, { endMs: s.endMs, label: s.label }));
  return out;
}

const SOURCES: AutofillSource[] = [
  { path: "/a.mp4", kind: "video", durationMs: 10_000, tags: ["hero"], shots: [0, 2500, 5000, 8000] },
  { path: "/b.mp4", kind: "video", durationMs: 10_000, tags: ["broll"], shots: null },
  { path: "/p.jpg", kind: "image", durationMs: 0, tags: [], shots: null },
];

const MOMENTS: Record<string, EditMoment[]> = {
  "/a.mp4": [
    { ms: 1200, strength: 0.4, kind: "motion" },
    { ms: 3000, strength: 0.9, kind: "cut" },
    { ms: 6000, strength: 0.7, kind: "motion" },
  ],
  "/b.mp4": [{ ms: 4000, strength: 0.5, kind: "cut" }],
};

function project(over: (p: NormalProject) => NormalProject = (p) => p): NormalProject {
  return over(normalizeProject(fixtureProject()));
}

function plan(settings: Partial<StyleSettings>, p = project(), range = { fromMs: 4000, toMs: 8000 }) {
  return planStyle({ project: p, markers: markers(), analysis, sources: SOURCES, selectedPaths: [], moments: MOMENTS, range, settings: { ...DEFAULT_SETTINGS, ...settings }, seed: 3, trackId: "t1" });
}

const track = (p: NormalProject, id: string) => p.tracks.find((t) => t.id === id)!;
const inRange = (cs: EditClip[], a: number, b: number) => cs.filter((c) => c.startMs >= a && c.endMs <= b);

describe("cutDensity", () => {
  const ms = markers();
  const range = { fromMs: 4000, toMs: 8000 };
  it("counts each lane's markers in the range", () => {
    expect(cutDensity(ms, "beat", 1, 100, range)).toHaveLength(8);
    expect(cutDensity(ms, "downbeat", 1, 100, range)).toHaveLength(2);
    expect(cutDensity(ms, "hats", 1, 100, range)).toHaveLength(16);
    expect(cutDensity(ms, "accent", 1, 100, range)).toHaveLength(0);
  });
  it("honours every-Nth and the min clip length", () => {
    expect(cutDensity(ms, "hats", 4, 100, range)).toHaveLength(4);
    expect(cutDensity(ms, "hats", 1, 500, range)).toHaveLength(8);
  });
});

describe("planStyle cuts", () => {
  it("replaces the clips in the range with cuts on the lane and keeps the rest", () => {
    const p = plan({ cutLane: "hats", minClipMs: 100 });
    expect(p.problem).toBeNull();
    const t = track(p.project!, "t1");
    const inside = inRange(t.clips, 4000, 8000);
    expect(inside.length).toBe(p.cuts);
    expect(p.cuts).toBeGreaterThan(10);
    // the long hand-made clip is trimmed to [0, 4000]
    expect(t.clips[0]).toMatchObject({ id: "c1", startMs: 0, endMs: 4000 });
    expect(t.clips.some((c) => c.id === "c2")).toBe(true);
    const ids = new Set(inside.map((c) => c.id));
    expect(validateShape(t.clips, ids, 24_000)).toBeNull();
    expect(new Set(t.clips.map((c) => c.id)).size).toBe(t.clips.length);
  });

  it("keeps pinned clips", () => {
    const p = project((q) => ({ ...q, tracks: q.tracks.map((t) => (t.id === "t1" ? { ...t, clips: [...t.clips, newClip({ id: "pin", kind: "video", path: "/b.mp4", startMs: 5000, endMs: 6000, pinned: true })].filter((c) => c.id !== "c1") } : t)) }));
    const res = plan({ cutLane: "beat" }, p);
    const t = track(res.project!, "t1");
    expect(t.clips.find((c) => c.id === "pin")).toMatchObject({ startMs: 5000, endMs: 6000, pinned: true });
    expect(t.clips.filter((c) => c.startMs >= 5000 && c.endMs <= 6000 && c.id !== "pin")).toHaveLength(0);
  });

  it("denser lanes cut more", () => {
    const hats = plan({ cutLane: "hats", minClipMs: 100 }).cuts;
    const beats = plan({ cutLane: "beat", minClipMs: 100 }).cuts;
    const down = plan({ cutLane: "downbeat", minClipMs: 100 }).cuts;
    expect(hats).toBeGreaterThan(beats);
    expect(beats).toBeGreaterThan(down);
  });

  it("keep leaves the clips and applies the transition", () => {
    const res = plan({ cutLane: "keep", transition: "flash", transitionMs: 120 }, project(), { fromMs: 0, toMs: 24_000 });
    expect(res.cuts).toBe(0);
    const c1 = track(res.project!, "t1").clips[0]!;
    expect(parseTransition(c1.in).value).toEqual({ kind: "flash", ms: 120 });
    expect(track(res.project!, "t1").clips.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("sets transitions and mirrored edges on new clips only", () => {
    const res = plan({ cutLane: "beat", transition: "whip", transitionMs: 150, mirror: true });
    const t = track(res.project!, "t1");
    const fresh = inRange(t.clips, 4000, 8000);
    for (const c of fresh) {
      expect(parseTransition(c.in).value.kind).toBe("whip");
      if (c.kind === "video") expect(parseTransform(c.transform).value.edges).toBe("mirror");
    }
    expect(t.clips.find((c) => c.id === "c2")?.in).toBe("");
  });
});

describe("distribution modes", () => {
  const videoPaths = (p: NormalProject) =>
    inRange(track(p, "t1").clips, 4000, 8000)
      .filter((c) => c.kind === "video")
      .map((c) => c.path);

  it("cycles evenly through the sources in order", () => {
    const res = plan({ cutLane: "beat", distribution: "cycle" });
    const paths = inRange(track(res.project!, "t1").clips, 4000, 8000).map((c) => c.path);
    expect(paths.slice(0, 3)).toEqual(["/a.mp4", "/b.mp4", "/p.jpg"]);
    expect(paths[3]).toBe("/a.mp4");
  });

  it("shuffles without repeating back to back and is deterministic", () => {
    const a = plan({ cutLane: "beat", distribution: "shuffle" });
    const b = plan({ cutLane: "beat", distribution: "shuffle" });
    const pa = inRange(track(a.project!, "t1").clips, 4000, 8000).map((c) => c.path);
    const pb = inRange(track(b.project!, "t1").clips, 4000, 8000).map((c) => c.path);
    expect(pa).toEqual(pb);
    pa.slice(1).forEach((x, i) => expect(x).not.toBe(pa[i]));
  });

  it("one clip, many moments cuts a single source and jumps between its moments", () => {
    const res = plan({ cutLane: "beat", distribution: "oneClip", oneSource: "/a.mp4" });
    const cs = inRange(track(res.project!, "t1").clips, 4000, 8000);
    expect(new Set(cs.map((c) => c.path))).toEqual(new Set(["/a.mp4"]));
    const ins = cs.map((c) => c.inMs);
    expect(new Set(ins).size).toBeGreaterThan(3);
    // in order: the first cut starts on the first moment/shot of the source
    expect(ins[0]).toBe(0);
    expect(ins[1]).toBeGreaterThan(0);
  });

  it("one clip falls back to the first video when the chosen one isn't available", () => {
    const res = plan({ cutLane: "beat", distribution: "oneClip", oneSource: "/gone.mp4" });
    expect(new Set(videoPaths(res.project!))).toEqual(new Set(["/a.mp4"]));
  });

  it("best moments starts each cut on a moment of its source, strongest first", () => {
    const res = plan({ cutLane: "downbeat", distribution: "best", sourceMode: "tags", tags: ["hero"] });
    const cs = inRange(track(res.project!, "t1").clips, 4000, 8000).filter((c) => c.kind === "video");
    expect(cs.length).toBeGreaterThan(0);
    expect(Math.abs(cs[0]!.inMs - 3000)).toBeLessThan(34);
    for (const c of cs) expect(MOMENTS["/a.mp4"]!.some((m) => Math.abs(m.ms - c.inMs) <= 34)).toBe(true);
  });

  it("best moments falls back to shot-aligned in points without moments", () => {
    const res = planStyle({ project: project(), markers: markers(), analysis, sources: SOURCES, selectedPaths: [], moments: {}, range: { fromMs: 4000, toMs: 8000 }, settings: { ...DEFAULT_SETTINGS, cutLane: "downbeat", distribution: "best", sourceMode: "tags", tags: ["hero"] }, seed: 3, trackId: "t1" });
    expect(res.problem).toBeNull();
    const cs = inRange(track(res.project!, "t1").clips, 4000, 8000);
    expect(cs.length).toBeGreaterThan(0);
  });

  it("never lets a clip run past the end of its source", () => {
    const res = plan({ cutLane: "kick", every: 8, minClipMs: 100, distribution: "best", sourceMode: "tags", tags: ["hero"] }, project(), { fromMs: 0, toMs: 24_000 });
    for (const c of track(res.project!, "t1").clips) if (c.kind === "video" && c.path === "/a.mp4" && c.auto) expect(c.inMs + (c.endMs - c.startMs)).toBeLessThanOrEqual(10_000);
  });
});

describe("adjustment clip", () => {
  it("creates a Section styles adjustment track on top with the effects", () => {
    const p = project();
    const res = plan({ cutLane: "beat", stackId: "anime-hit", hitLane: "accent", strength: 0.6 }, p);
    const tracks = res.project!.tracks;
    expect(tracks.length).toBe(p.tracks.length + 1);
    const t = tracks[tracks.length - 1]!;
    expect(t).toMatchObject({ kind: "adjust", name: STYLE_TRACK_NAME });
    expect(t.clips).toHaveLength(1);
    expect(t.clips[0]).toMatchObject({ kind: "adjust", startMs: 4000, endMs: 8000 });
    const fx = parseEffects(t.clips[0]!.effects).value;
    expect(fx.length).toBe(4);
    for (const f of fx) {
      const amount = f.params.amount as { mods?: Array<{ signal: string }> };
      expect(amount.mods?.[0]?.signal).toBe("marker.accent");
    }
  });

  it("follows the cut lane by default", () => {
    expect(resolveHitLane({ cutLane: "hats", hitLane: "cut" })).toBe("hats");
    expect(resolveHitLane({ cutLane: "keep", hitLane: "cut" })).toBe("beat");
    const fx = styleEffects("anime-hit", "hats", 1);
    expect(JSON.stringify(fx)).toContain("marker.hats");
    expect(JSON.stringify(fx)).not.toContain("marker.kick");
  });

  it("leaves effects with no hit alone (Manga)", () => {
    const manga = styleEffects("manga", "hats", 1);
    expect(manga.length).toBeGreaterThan(0);
    expect(JSON.stringify(manga)).not.toContain("marker.");
  });

  it("replaces an overlapping adjustment clip and trims partial neighbours", () => {
    const first = plan({ cutLane: "beat", stackId: "glow-pump" }, project(), { fromMs: 4000, toMs: 12_000 }).project!;
    const second = planStyle({ project: first, markers: markers(), analysis, sources: SOURCES, selectedPaths: [], moments: {}, range: { fromMs: 8000, toMs: 16_000 }, settings: { ...DEFAULT_SETTINGS, cutLane: "keep", stackId: "anime-hit" }, seed: 1, trackId: "t1" });
    expect(second.problem).toBeNull();
    const styles = second.project!.tracks.filter((t) => t.name === STYLE_TRACK_NAME);
    expect(styles).toHaveLength(1);
    const spans = styles[0]!.clips.map((c) => [c.startMs, c.endMs]);
    expect(spans).toEqual([
      [4000, 8000],
      [8000, 16_000],
    ]);
  });

  it("splits a clip that spans the whole range", () => {
    const c = newClip({ id: "w", kind: "adjust", startMs: 0, endMs: 20_000 });
    const out = clearAdjustRange([c], 5000, 10_000);
    expect(out.map((x) => [x.startMs, x.endMs])).toEqual([
      [0, 5000],
      [10_000, 20_000],
    ]);
    expect(new Set(out.map((x) => x.id)).size).toBe(2);
  });

  it("adds no track when no effects are chosen", () => {
    const p = project();
    const res = plan({ cutLane: "beat", stackId: "none" }, p);
    expect(res.project!.tracks.length).toBe(p.tracks.length);
    expect(res.hasEffects).toBe(false);
  });

  it("refuses to add the track beyond 8 tracks", () => {
    const p = project((q) => {
      const extra = Array.from({ length: 8 - q.tracks.length }, (_, i) => ({ ...q.tracks[0]!, id: `x${i}`, clips: [] as EditClip[] }));
      return { ...q, tracks: [...q.tracks, ...extra] };
    });
    expect(p.tracks.length).toBe(8);
    const res = plan({ cutLane: "beat", stackId: "anime-hit" }, p);
    expect(res.project).toBeNull();
    expect(res.problem).toMatch(/8 tracks/);
  });
});

describe("range helpers", () => {
  const p = project();
  const ms = markers();
  it("prefers a selected range, then clips, then the section at the playhead", () => {
    expect(rangeFromContext(p, ms, { kind: "range", fromMs: 1000, toMs: 2000 }, 0)).toEqual({ fromMs: 1000, toMs: 2000 });
    expect(rangeFromContext(p, ms, { kind: "clips", ids: ["c1", "c2"] }, 0)).toEqual({ fromMs: 0, toMs: 16_000 });
    expect(rangeFromContext(p, ms, null, 9000)).toEqual({ fromMs: 8000, toMs: 16_000 });
  });
  it("snaps to section edges and bars", () => {
    expect(snapToGrid(8100, ms)).toBe(8000);
    expect(snapToGrid(5050, ms)).toBe(5050);
    expect(snapToGrid(6100, ms)).toBe(6000);
  });
});
