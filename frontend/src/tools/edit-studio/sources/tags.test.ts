import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { appendSources, allTags, filterSources, MAX_SOURCES, normalizeTag, relinkPath, setSourceTags, toggleTag, usedCounts } from "./tags";

const doc = () => normalizeProject(fixtureProject());

describe("tags", () => {
  it("normalises", () => {
    expect(normalizeTag("  Hero Shot ")).toBe("hero-shot");
    expect(normalizeTag("***")).toBeNull();
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("a".repeat(40))).toHaveLength(24);
    expect(normalizeTag("Nächt_1")).toBe("nächt_1");
  });
  it("toggles and caps at 8", () => {
    expect(toggleTag(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTag(["a", "b"], "a")).toEqual(["b"]);
    const full = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(toggleTag(full, "9")).toBeNull();
    expect(toggleTag(full, "8")).toHaveLength(7);
  });
  it("sets tags on one source only", () => {
    const d = setSourceTags(doc(), "/fixture/photo.jpg", ["wide"]);
    expect(d.sources.find((s) => s.path === "/fixture/photo.jpg")?.tags).toEqual(["wide"]);
    expect(d.sources.find((s) => s.path === "/fixture/a.mp4")?.tags).toEqual(["hero"]);
    expect(setSourceTags(doc(), "/nope", ["x"]).sources).toEqual(doc().sources);
  });
  it("lists presets first, then custom tags", () => {
    const d = setSourceTags(doc(), "/fixture/photo.jpg", ["night", "alpha"]);
    expect(allTags(d.sources)).toEqual(["hero", "closeup", "wide", "broll", "alpha", "night"]);
  });
  it("filters by any tag", () => {
    const d = doc();
    expect(filterSources(d.sources, []).length).toBe(3);
    expect(filterSources(d.sources, ["hero", "broll"]).map((s) => s.path)).toEqual(["/fixture/a.mp4", "/fixture/b.mp4"]);
    expect(filterSources(d.sources, ["wide"])).toEqual([]);
  });
  it("counts uses", () => {
    const c = usedCounts(doc());
    expect(c.get("/fixture/a.mp4")).toBe(1);
    expect(c.get("/fixture/photo.jpg")).toBe(1);
    expect(c.get("/zzz")).toBeUndefined();
  });
});

describe("appendSources", () => {
  it("dedupes and appends in order", () => {
    const r = appendSources(doc(), ["/fixture/a.mp4", "/new1.mp4", "/new1.mp4", "/new2.jpg"]);
    expect(r.added).toEqual(["/new1.mp4", "/new2.jpg"]);
    expect(r.project.sources).toHaveLength(5);
    expect(appendSources(doc(), ["/fixture/a.mp4"]).project).toBeTruthy();
  });
  it("returns the same project when nothing is new", () => {
    const d = doc();
    expect(appendSources(d, ["/fixture/a.mp4"]).project).toBe(d);
  });
  it("stops at 300", () => {
    const d = { ...doc(), sources: Array.from({ length: MAX_SOURCES - 1 }, (_, i) => ({ path: `/s${i}.mp4`, tags: [] })) };
    const r = appendSources(d, ["/x1.mp4", "/x2.mp4"]);
    expect(r.added).toEqual(["/x1.mp4"]);
    expect(r.project.sources).toHaveLength(MAX_SOURCES);
  });
});

describe("relinkPath", () => {
  it("replaces the path in sources and every clip", () => {
    const d = relinkPath(doc(), "/fixture/a.mp4", "/moved/a.mp4");
    expect(d.sources.map((s) => s.path)).toContain("/moved/a.mp4");
    expect(d.sources.map((s) => s.path)).not.toContain("/fixture/a.mp4");
    expect(d.sources.find((s) => s.path === "/moved/a.mp4")?.tags).toEqual(["hero"]);
    expect(d.tracks.flatMap((t) => t.clips).filter((c) => c.path === "/moved/a.mp4")).toHaveLength(1);
    expect(d.tracks.flatMap((t) => t.clips).some((c) => c.path === "/fixture/a.mp4")).toBe(false);
  });
  it("merges into an existing entry", () => {
    const d = relinkPath(doc(), "/fixture/a.mp4", "/fixture/b.mp4");
    expect(d.sources.filter((s) => s.path === "/fixture/b.mp4")).toHaveLength(1);
    expect(d.sources.find((s) => s.path === "/fixture/b.mp4")?.tags).toEqual(["broll", "hero"]);
    expect(d.sources).toHaveLength(2);
  });
  it("does nothing for an unknown path", () => {
    const d = doc();
    expect(relinkPath(d, "/nope", "/else")).toBe(d);
    expect(relinkPath(d, "/fixture/a.mp4", "/fixture/a.mp4")).toBe(d);
  });
});
