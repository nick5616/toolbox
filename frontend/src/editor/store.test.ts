import { describe, expect, it } from "vitest";
import { fixtureProject } from "@/viz/edit/fixture";
import { normalizeProject } from "@/viz/edit/defaults";
import { allClips, clipSourceSpan, findClip, newClip, withClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";

describe("edit studio store and doc helpers", () => {
  it("opens, edits with coalescing, undoes and redoes", () => {
    const st = useEditStudio.getState();
    const doc = normalizeProject(fixtureProject());
    st.open("p1", "Edit", doc);
    expect(useEditStudio.getState().history?.present).toBe(doc);
    const a = withClip(doc, "c1", { volume: 1 });
    const b = withClip(a, "c1", { volume: 2 });
    useEditStudio.getState().edit(a, "vol");
    useEditStudio.getState().edit(b, "vol");
    expect(useEditStudio.getState().history?.past.length).toBe(1);
    expect(useEditStudio.getState().saveState).toBe("dirty");
    useEditStudio.getState().undo();
    expect(useEditStudio.getState().history?.present).toBe(doc);
    useEditStudio.getState().redo();
    expect(findClip(useEditStudio.getState().history!.present, "c1")?.clip.volume).toBe(2);
    useEditStudio.getState().close();
    expect(useEditStudio.getState().projectId).toBeNull();
  });

  it("clears auto on edits unless the patch sets it", () => {
    const doc = normalizeProject(fixtureProject());
    const auto = withClip(doc, "c1", { auto: true });
    expect(findClip(auto, "c1")?.clip.auto).toBe(true);
    expect(findClip(withClip(auto, "c1", { volume: 1 }), "c1")?.clip.auto).toBe(false);
    expect(withClip(doc, "nope", { volume: 1 })).toBe(doc);
  });

  it("finds clips and integrates the source span", () => {
    const doc = normalizeProject(fixtureProject());
    expect(allClips(doc).map((c) => c.clip.id)).toEqual(["c1", "c2", "c3", "c4"]);
    const c = newClip({ kind: "video", path: "/a.mp4", startMs: 0, endMs: 2000, inMs: 500, speed: "2" });
    expect(clipSourceSpan(c, 30)).toEqual({ fromMs: 500, toMs: 4500 });
  });

  it("normalizes nulls with stable identity", () => {
    const doc = normalizeProject(fixtureProject());
    expect(normalizeProject(doc)).toBe(doc);
    const withNulls = { ...doc, sources: null, markers: { ...doc.markers, hidden: null } };
    const n = normalizeProject(withNulls);
    expect(n.sources).toEqual([]);
    expect(n.markers.hidden).toEqual([]);
  });
});
