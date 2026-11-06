import { describe, expect, it } from "vitest";
import type { EditClip } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureKicks, fixtureProject } from "@/viz/edit/fixture";
import { parseEffects, parseSpeed, parseTransition } from "@/viz/edit/schema";
import type { Marker, MarkerLane } from "@/viz/edit/types";
import { newClip } from "@/editor/doc";
import { autofill, validateShape } from "./autofill";
import { RECIPES } from "./recipes";
import type { AutofillInput, AutofillOptions, AutofillSource, Recipe } from "./types";

const analysis = buildEditFixture();

const mk = (lane: MarkerLane, ms: number, extra: Partial<Marker> = {}): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1, ...extra });

function fixtureMarkers(opts: { phrases?: boolean } = {}): Marker[] {
  const out: Marker[] = [];
  for (let t = 0; t < 24_000; t += 500) out.push(mk("beat", t));
  for (let t = 0; t < 24_000; t += 2000) out.push(mk("downbeat", t));
  for (const t of fixtureKicks()) out.push(mk("kick", t));
  out.push(mk("stop", 15_000, { endMs: 15_400 }));
  out.push(mk("drop", 16_000));
  if (opts.phrases !== false) for (const t of [4000, 6000, 8000]) out.push(mk("phrase", t, { endMs: t + 1800 }));
  for (const s of analysis.audio.sections) out.push(mk("section", s.startMs, { endMs: s.endMs, label: s.label }));
  return out;
}

const SOURCES: AutofillSource[] = [
  { path: "/a.mp4", kind: "video", durationMs: 10_000, tags: ["hero"], shots: [0, 2500, 5000, 8000] },
  { path: "/b.mp4", kind: "video", durationMs: 10_000, tags: ["broll"], shots: null },
  { path: "/c.mp4", kind: "video", durationMs: 10_000, tags: ["broll"], shots: null },
  { path: "/p.jpg", kind: "image", durationMs: 0, tags: [], shots: null },
];

const VIDEOS = SOURCES.filter((s) => s.kind === "video");

function baseProject(clips: EditClip[] = []): NormalProject {
  const p = normalizeProject(fixtureProject());
  return { ...p, tracks: [{ ...p.tracks[0]!, clips }, ...p.tracks.slice(1)] };
}

function opts(over: Partial<AutofillOptions> = {}): AutofillOptions {
  return { recipeId: "downbeat", seed: 1, order: "recipe", sources: "all", trackId: "t1", range: null, ...over };
}

function recipe(id: string): Recipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
}

function run(id: string, over: Partial<AutofillOptions> = {}, extra: Partial<AutofillInput> = {}) {
  const input: AutofillInput = {
    project: baseProject(),
    markers: fixtureMarkers(),
    analysis,
    sources: SOURCES,
    recipe: recipe(id),
    options: opts({ recipeId: id, ...over }),
    ...extra,
  };
  return autofill(input);
}

const cuts = (r: { clips: EditClip[] }) => r.clips.map((c) => c.startMs);
const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
};

describe("recipes", () => {
  it("ships the five presets", () => {
    expect(RECIPES.map((r) => r.id).slice(0, 5)).toEqual(["downbeat", "kick", "chorus-double", "hold-verse", "drop-slam"]);
    const slam = recipe("drop-slam");
    expect(slam.onStop).toBe("freeze");
    expect(slam.onDrop?.tag).toBe("hero");
    expect(slam.onDrop?.transition).toEqual({ kind: "flash", ms: 300 });
  });
});

describe("autofill golden cut lists", () => {
  it("downbeat: one clip per bar covering the whole edit", () => {
    const r = run("downbeat");
    expect(cuts(r)).toEqual(range(0, 24_000, 2000));
    expect(r.clips.at(-1)?.endMs).toBe(24_000);
    expect(r.warnings).toEqual([]);
    expect(r.clips.map((c) => c.id)).toEqual(r.clips.map((_, i) => `a1-${i + 1}`));
    for (const c of r.clips) expect(c).toMatchObject({ auto: true, pinned: false, fit: "fill" });
  });

  it("downbeat sequential: sources in panel order, in-points continue per source", () => {
    const r = run("downbeat");
    expect(r.clips.slice(0, 5).map((c) => c.path)).toEqual(["/a.mp4", "/b.mp4", "/c.mp4", "/p.jpg", "/a.mp4"]);
    expect(r.clips[0]?.inMs).toBe(0);
    expect(r.clips[4]?.inMs).toBe(2000);
    expect(r.clips[8]?.inMs).toBe(4000);
    expect(r.clips[3]?.kind).toBe("image");
  });

  it("kick: cuts on kicks (kick-less stop skipped), no same source twice in a row", () => {
    const r = run("kick");
    const expected = fixtureKicks().filter((t) => t % 500 === 0);
    expect(cuts(r)).toEqual(expected);
    for (let i = 1; i < r.clips.length; i++) expect(r.clips[i]?.path === r.clips[i - 1]?.path && r.clips[i]?.kind === "video").toBe(false);
    for (const c of r.clips) if (c.kind === "video") expect(c.inMs + (c.endMs - c.startMs)).toBeLessThanOrEqual(10_000);
  });

  it("chorus-double: beat cuts in chorus and drop, bars elsewhere", () => {
    const r = run("chorus-double");
    expect(cuts(r)).toEqual([...range(0, 8000, 2000), ...range(8000, 24_000, 500)]);
  });

  it("hold-verse: phrase holds, kick cuts in the chorus, bars in the rest", () => {
    const r = run("hold-verse");
    // the intro has no phrase inside (one hold), the verse cuts on its phrase at 6 s
    expect(cuts(r).filter((t) => t < 8000)).toEqual([0, 4000, 6000]);
    // chorus and drop on kicks: every 500 ms except inside the stop
    const chorus = cuts(r).filter((t) => t >= 8000 && t < 24_000);
    expect(chorus).toEqual(fixtureKicks().filter((t) => t >= 8000));
  });

  it("drop-slam: drop slice uses the hero source, with effects, flash transition and a freeze", () => {
    const r = run("drop-slam", {}, { sources: VIDEOS });
    const dropClip = r.clips.find((c) => c.startMs === 16_000);
    expect(dropClip?.path).toBe("/a.mp4");
    expect(parseTransition(dropClip?.in ?? "").value).toEqual({ kind: "flash", ms: 300 });
    const fx = parseEffects(dropClip?.effects ?? "").value;
    expect(fx.map((e) => e.type)).toEqual(["punch", "punch", "flash"]);
    // drop section kick clips carry punch, others none
    const later = r.clips.find((c) => c.startMs === 16_500);
    expect(parseEffects(later?.effects ?? "").value.map((e) => e.type)).toEqual(["punch"]);
    expect(r.clips.find((c) => c.startMs === 0)?.effects).toBe("");
    // freeze on the stop at 15–15.4 s: the clip under it (bar 14–16 s) gets speed keys
    const under = r.clips.find((c) => c.startMs <= 15_000 && c.endMs > 15_000);
    expect(under).toBeDefined();
    const sp = parseSpeed(under?.speed ?? "").value;
    expect(typeof sp).toBe("object");
    if (typeof sp === "object") {
      const rel = 15_000 - (under?.startMs ?? 0);
      expect(sp.keys).toEqual([
        { t: 0, v: 1, ease: "hold" },
        { t: rel, v: 0, ease: "hold" },
        { t: rel + 400, v: 1, ease: "hold" },
      ]);
    }
  });
});

describe("determinism", () => {
  it("same seed gives identical clips; different seeds differ for shuffle presets", () => {
    const a = run("kick", { seed: 5 });
    const b = run("kick", { seed: 5 });
    const c = run("kick", { seed: 6 });
    expect(b).toEqual(a);
    expect(c.clips.map((x) => [x.path, x.inMs])).not.toEqual(a.clips.map((x) => [x.path, x.inMs]));
  });

  it("run number comes from the project's last run", () => {
    const r = run("downbeat", {}, { project: { ...baseProject(), recipe: { recipeId: "downbeat", seed: 1, run: 4, options: "{}" } } });
    expect(r.clips[0]?.id).toBe("a5-1");
  });
});

describe("pinned, edited and removed clips", () => {
  const user = newClip({ id: "u1", kind: "image", path: "/p.jpg", startMs: 3000, endMs: 5000 }); // !auto
  const pinned = newClip({ id: "p1", kind: "image", path: "/p.jpg", startMs: 9000, endMs: 9600, auto: true, pinned: true });
  const old = newClip({ id: "a0-1", kind: "image", path: "/p.jpg", startMs: 0, endMs: 2000, auto: true });
  const old2 = newClip({ id: "a0-2", kind: "image", path: "/p.jpg", startMs: 20_000, endMs: 22_000, auto: true });

  it("keeps them and cuts slices around them", () => {
    const r = run("downbeat", {}, { project: baseProject([old, user, pinned, old2]) });
    expect(r.removed.sort()).toEqual(["a0-1", "a0-2"]);
    const all = [...r.clips, user, pinned];
    expect(validateShape(all, new Set(r.clips.map((c) => c.id)), 24_000)).toBeNull();
    // slice 2000–4000 becomes 2000–3000 (1000 ms kept), 4000–6000 becomes 5000–6000
    expect(r.clips.some((c) => c.startMs === 2000 && c.endMs === 3000)).toBe(true);
    expect(r.clips.some((c) => c.startMs === 5000 && c.endMs === 6000)).toBe(true);
    // 8000–10000 around the pinned clip 9000–9600: 8000–9000 and 9600–10000 (400 ms ≥ 250)
    expect(r.clips.some((c) => c.startMs === 8000 && c.endMs === 9000)).toBe(true);
    expect(r.clips.some((c) => c.startMs === 9600 && c.endMs === 10_000)).toBe(true);
  });

  it("drops pieces shorter than minClipMs", () => {
    const tight = newClip({ id: "u2", kind: "image", path: "/p.jpg", startMs: 2100, endMs: 3900 });
    const r = run("downbeat", {}, { project: baseProject([tight]) });
    expect(r.clips.some((c) => c.startMs >= 2000 && c.endMs <= 4000)).toBe(false);
  });
});

describe("range and sections", () => {
  it("range only: clips stay inside, other auto clips untouched", () => {
    const outside = newClip({ id: "a0-9", kind: "image", path: "/p.jpg", startMs: 20_000, endMs: 22_000, auto: true });
    const inside = newClip({ id: "a0-1", kind: "image", path: "/p.jpg", startMs: 8000, endMs: 10_000, auto: true });
    const r = run("downbeat", { range: { fromMs: 8000, toMs: 12_000 } }, { project: baseProject([inside, outside]) });
    expect(cuts(r)).toEqual([8000, 10_000]);
    expect(r.clips.at(-1)?.endMs).toBe(12_000);
    expect(r.removed).toEqual(["a0-1"]);
  });

  it("section only: a range that is one section", () => {
    const r = run("chorus-double", { range: { fromMs: 8000, toMs: 16_000 } });
    expect(cuts(r)).toEqual(range(8000, 16_000, 500));
  });

  it("a section with no matching rule is left empty", () => {
    const only: Recipe = { id: "chorus-only", name: "x", description: "", rules: [{ sections: ["chorus"], cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start" }] };
    const r = run("downbeat", {}, { recipe: only });
    expect(cuts(r)).toEqual(range(8000, 16_000, 2000));
  });

  it("snaps cuts to the frame grid and merges close cuts", () => {
    const m = [...fixtureMarkers().filter((x) => x.lane !== "kick"), mk("kick", 8010), mk("kick", 8100), mk("kick", 9000)];
    const r = run("kick", {}, { markers: m });
    // 8010 merges into the section start (8000); 8100 is < 120 ms after... kept cuts are ≥ 120 apart
    for (let i = 1; i < r.clips.length; i++) expect(r.clips[i]!.startMs - r.clips[i - 1]!.startMs).toBeGreaterThanOrEqual(120);
    for (const c of r.clips) expect(Math.round(Math.round((c.startMs * 30) / 1000) * (1000 / 30))).toBe(c.startMs);
  });

  it("never drops a drop or a section boundary when merging", () => {
    const m = [...fixtureMarkers(), mk("kick", 16_040)];
    const r = run("drop-slam", {}, { markers: m });
    expect(cuts(r)).toContain(16_000);
    expect(cuts(r)).not.toContain(16_040);
  });
});

describe("tags and fallbacks", () => {
  it("byTag uses tagged sources and falls back to all with a warning", () => {
    const tagged: Recipe = { id: "t", name: "t", description: "", rules: [{ cutLane: "downbeat", sourceOrder: "byTag", tags: ["broll"], videoIn: "start" }] };
    const r = run("downbeat", {}, { recipe: tagged });
    expect(new Set(r.clips.map((c) => c.path))).toEqual(new Set(["/b.mp4", "/c.mp4"]));
    const none: Recipe = { ...tagged, rules: [{ cutLane: "downbeat", sourceOrder: "byTag", tags: ["nope"], videoIn: "start" }] };
    const r2 = run("downbeat", {}, { recipe: none });
    expect(r2.clips.length).toBe(12);
    expect(r2.warnings.join(" ")).toContain("nope");
  });

  it("options.order overrides the recipe's own", () => {
    const seq = run("kick", { order: "sequential" });
    expect(seq.clips.slice(0, 4).map((c) => c.path)).toEqual(["/a.mp4", "/b.mp4", "/c.mp4", "/p.jpg"]);
  });

  it("an explicit source list is honoured in that order", () => {
    const r = run("downbeat", { sources: ["/c.mp4", "/a.mp4", "/missing.mp4"] });
    expect(r.clips.slice(0, 3).map((c) => c.path)).toEqual(["/c.mp4", "/a.mp4", "/c.mp4"]);
  });

  it("an empty phrase lane falls back to downbeats with a warning", () => {
    const r = run("hold-verse", {}, { markers: fixtureMarkers({ phrases: false }) });
    expect(r.warnings.join(" ")).toMatch(/phrase lane is empty/);
    expect(cuts(r).filter((t) => t >= 4000 && t < 8000)).toEqual([4000, 6000]);
  });

  it("no sources gives a warning and nothing", () => {
    const r = run("downbeat", {}, { sources: [] });
    expect(r.clips).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no sources/i);
  });

  it("short videos are used whole and the slice continues with the next source", () => {
    const shorts: AutofillSource[] = [
      { path: "/s1.mp4", kind: "video", durationMs: 700, tags: [], shots: null },
      { path: "/s2.mp4", kind: "video", durationMs: 700, tags: [], shots: null },
    ];
    const r = run("downbeat", { range: { fromMs: 0, toMs: 2000 } }, { sources: shorts });
    expect(r.clips.length).toBeGreaterThan(2);
    expect(r.clips[0]).toMatchObject({ path: "/s1.mp4", startMs: 0, inMs: 0 });
    expect(r.clips[0]!.endMs).toBeGreaterThanOrEqual(690);
    expect(r.clips[1]).toMatchObject({ path: "/s2.mp4", startMs: r.clips[0]!.endMs });
    expect(r.clips.at(-1)!.endMs).toBeGreaterThan(1900);
  });

  it("shotAligned picks the first shot at or after the cursor that leaves room", () => {
    const one: AutofillSource[] = [{ path: "/a.mp4", kind: "video", durationMs: 10_000, tags: [], shots: [0, 2500, 5000, 8000] }];
    const rule: Recipe = { id: "sh", name: "s", description: "", rules: [{ cutLane: "downbeat", sourceOrder: "sequential", videoIn: "shotAligned" }] };
    const r = run("downbeat", { range: { fromMs: 0, toMs: 6000 } }, { sources: one, recipe: rule });
    // 2 s slices: first at 0 (cursor 0 -> shot 0), cursor 2000 -> shot 2500, cursor 4500 -> shot 5000
    expect(r.clips.map((c) => c.inMs)).toEqual([0, 2500, 5000]);
  });
});

describe("stops", () => {
  it("black: a color clip over the stop splits the clip under it", () => {
    const black: Recipe = { ...recipe("downbeat"), id: "black", onStop: "black" };
    const r = run("downbeat", {}, { recipe: black, sources: VIDEOS });
    const blackClip = r.clips.find((c) => c.kind === "color");
    expect(blackClip).toMatchObject({ startMs: 15_000, endMs: 15_400, color: "#000000", auto: true });
    const left = r.clips.find((c) => c.endMs === 15_000);
    const right = r.clips.find((c) => c.startMs === 15_400);
    expect(left?.startMs).toBe(14_000);
    expect(right?.endMs).toBe(16_000);
    const plain = run("downbeat", {}, { recipe: { ...recipe("downbeat"), onStop: "none" }, sources: VIDEOS });
    const orig = plain.clips.find((c) => c.startMs === 14_000);
    expect(right?.inMs).toBe((orig?.inMs ?? 0) + 1400);
    expect(right?.path).toBe(orig?.path);
    expect(validateShape(r.clips, new Set(r.clips.map((c) => c.id)), 24_000)).toBeNull();
  });

  it("none leaves clips alone", () => {
    const none: Recipe = { ...recipe("downbeat"), onStop: "none" };
    const r = run("downbeat", {}, { recipe: none });
    expect(r.clips.some((c) => c.kind === "color" || c.speed !== "")).toBe(false);
  });
});

describe("performance", () => {
  it("a 3-minute song with 300 sources fills in under 2 s", () => {
    const markers: Marker[] = [mk("section", 0, { endMs: 60_000, label: "verse" }), mk("section", 60_000, { endMs: 120_000, label: "chorus" }), mk("section", 120_000, { endMs: 180_000, label: "drop" })];
    for (let t = 0; t < 180_000; t += 500) markers.push(mk("beat", t), mk("kick", t));
    for (let t = 0; t < 180_000; t += 2000) markers.push(mk("downbeat", t));
    const sources: AutofillSource[] = Array.from({ length: 300 }, (_, i) => ({ path: `/s${i}.mp4`, kind: "video" as const, durationMs: 20_000, tags: i % 5 === 0 ? ["hero"] : [], shots: [0, 5000, 10_000] }));
    const p = baseProject();
    const long = { ...p, song: { ...p.song!, endMs: 180_000 } };
    const t0 = performance.now();
    const r = run("drop-slam", {}, { project: long, markers, sources });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.clips.length).toBeGreaterThan(100);
  });
});
