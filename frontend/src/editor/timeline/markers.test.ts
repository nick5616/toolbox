import { describe, expect, it } from "vitest";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { addRulerMarker, moveRulerMarker, renameRulerMarker, rulerMarkers } from "./markers";

const base = (song: NormalProject["song"] = null): NormalProject => ({ ...normalizeProject(fixtureProject()), song, markers: { ...normalizeProject(fixtureProject()).markers, custom: [] } });

describe("ruler markers (Video Editor)", () => {
  it("without a song the marker's ms is the timeline ms", () => {
    const r = addRulerMarker(base(), 2500);
    expect(r?.project.markers.custom[0]).toMatchObject({ ms: 2500, label: "" });
    expect(rulerMarkers(r?.project as NormalProject)).toEqual([{ id: r?.id, ms: 2500, label: "" }]);
  });
  it("with a song they are song ms: song start + timeline ms", () => {
    const d = base({ path: "/s.mp3", startMs: 10_000, endMs: 30_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
    const r = addRulerMarker(d, 2500);
    expect(r?.project.markers.custom[0]?.ms).toBe(12_500);
    expect(rulerMarkers(r?.project as NormalProject)[0]?.ms).toBe(2500);
  });
  it("refuses a second marker at the same time", () => {
    const r = addRulerMarker(base(), 1000);
    expect(addRulerMarker(r?.project as NormalProject, 1000)).toBeNull();
  });
  it("moves and names a marker; no-ops are null", () => {
    const r = addRulerMarker(base(), 1000) as NonNullable<ReturnType<typeof addRulerMarker>>;
    const moved = moveRulerMarker(r.project, r.id, 4000);
    expect(rulerMarkers(moved as NormalProject)[0]?.ms).toBe(4000);
    expect(moveRulerMarker(r.project, r.id, 1000)).toBeNull();
    expect(moveRulerMarker(r.project, "nope", 5)).toBeNull();
    const named = renameRulerMarker(r.project, r.id, "  Drop  ");
    expect(rulerMarkers(named as NormalProject)[0]?.label).toBe("Drop");
    expect(renameRulerMarker(named as NormalProject, r.id, "Drop")).toBeNull();
  });
  it("lists them ascending and drops ones before the song start", () => {
    const d = base({ path: "/s.mp3", startMs: 10_000, endMs: 30_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
    d.markers.custom = [
      { id: "b", ms: 15_000, label: "" },
      { id: "a", ms: 11_000, label: "" },
      { id: "z", ms: 500, label: "" },
    ];
    expect(rulerMarkers(d).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
