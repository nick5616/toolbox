import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { deriveMarkers } from "@/viz/edit/markers";
import type { Marker } from "@/viz/edit/types";
import { formatMs } from "@/components/media/logic";
import {
  addCustomMarker,
  buildMarkerRows,
  deleteMarkers,
  describeMarker,
  groupByLane,
  hitTest,
  moveMarker,
  nearestCustom,
  renameCustomMarker,
  renameSection,
  resetLaneOverrides,
  snapSongMs,
  tap,
  visibleMarkers,
  withLane,
  MAX_HIDDEN,
} from "./laneLogic";

const a = buildEditFixture();
const base = normalizeProject(fixtureProject());
const range = { startMs: 0, endMs: 24_000 };
const mk = (id: string, lane: Marker["lane"], ms: number, extra: Partial<Marker> = {}): Marker => ({ id, lane, ms, strength: 1, ...extra });

describe("marker edits", () => {
  it("moves a derived marker into `moved` and a custom marker in place", () => {
    const m = mk("kick:1000", "kick", 1000);
    const p = moveMarker(base, m, 1234.4);
    expect(p.markers.moved["kick:1000"]).toBe(1234);
    expect(moveMarker(p, m, 1234)).toBe(p);
    const c = addCustomMarker(base, 2000)!;
    const moved = moveMarker(c.project, mk(c.id, "custom", 2000), 2500);
    expect(moved.markers.custom[0]?.ms).toBe(2500);
  });

  it("delete hides derived markers and removes custom ones", () => {
    const c = addCustomMarker(base, 2000)!;
    const r = deleteMarkers(c.project, [mk("snare:1500", "snare", 1500), mk(c.id, "custom", 2000)]);
    expect(r).toMatchObject({ removed: 1, hidden: 1, full: false });
    expect(r.project.markers.hidden).toEqual(["snare:1500"]);
    expect(r.project.markers.custom.length).toBe(0);
    // idempotent
    expect(deleteMarkers(r.project, [mk("snare:1500", "snare", 1500)]).project).toBe(r.project);
  });

  it("the hidden list is capped", () => {
    const full = { ...base, markers: { ...base.markers, hidden: Array.from({ length: MAX_HIDDEN }, (_, i) => `kick:${i}`) } };
    const r = deleteMarkers(full, [mk("kick:99999", "kick", 1)]);
    expect(r.full).toBe(true);
    expect(r.project).toBe(full);
  });

  it("custom markers: cap, range, label length, rename", () => {
    expect(addCustomMarker(base, -5)).toBeNull();
    expect(addCustomMarker(base, 24_000)).toBeNull();
    const c = addCustomMarker(base, 100, "x".repeat(80))!;
    expect(c.project.markers.custom[0]?.label.length).toBe(40);
    expect(c.id).toMatch(/^k/);
    const capped = { ...base, markers: { ...base.markers, custom: Array.from({ length: 2000 }, (_, i) => ({ id: `k${i}`, ms: i, label: "" })) } };
    expect(addCustomMarker(capped, 5000)).toBeNull();
    expect(renameCustomMarker(c.project, c.id, "  Hit  ").markers.custom[0]?.label).toBe("Hit");
  });

  it("section rename sets and clears", () => {
    const p = renameSection(base, "section:8000", "Hook");
    expect(p.markers.labels["section:8000"]).toBe("Hook");
    expect(renameSection(p, "section:8000", " ").markers.labels).toEqual({});
  });

  it("reset lane clears only that lane's overrides", () => {
    const st = { ...base, markers: { ...base.markers, hidden: ["kick:0", "snare:500"], moved: { "kick:500": 510, "snare:1500": 1510 }, labels: { "section:0": "Intro!" } } };
    const r = resetLaneOverrides(st, "kick");
    expect(r.markers.hidden).toEqual(["snare:500"]);
    expect(r.markers.moved).toEqual({ "snare:1500": 1510 });
    expect(resetLaneOverrides(r, "kick")).toBe(r);
    expect(resetLaneOverrides(st, "section").markers.labels).toEqual({});
  });

  it("withLane patches settings", () => {
    const p = withLane(base, "hats", { visible: true, minStrength: 0.4 });
    expect(p.markers.lanes.hats).toMatchObject({ visible: true, minStrength: 0.4, every: 1 });
  });
});

describe("snapping", () => {
  it("snaps to a beat within 40 ms unless disabled", () => {
    expect(snapSongMs(a, 1030, true)).toBe(1000);
    expect(snapSongMs(a, 1041, true)).toBe(1041);
    expect(snapSongMs(a, 1030, false)).toBe(1030);
  });
});

describe("tap", () => {
  it("adds a marker, and a second tap within 250 ms deletes the nearest within 150 ms", () => {
    const st = { lastAt: -Infinity };
    const r1 = tap(base, st, 1000, 3000);
    expect(r1.kind).toBe("added");
    if (r1.kind !== "added") return;
    expect(r1.project.markers.custom.length).toBe(1);
    const r2 = tap(r1.project, st, 1200, 3100);
    expect(r2.kind).toBe("deleted");
    if (r2.kind !== "deleted") return;
    expect(r2.project.markers.custom.length).toBe(0);
    // a third quick tap starts again
    expect(tap(r2.project, st, 1300, 3200).kind).toBe("added");
  });
  it("a second tap with no custom marker near does nothing; a slow second tap adds", () => {
    const st = { lastAt: -Infinity };
    const r1 = tap(base, st, 1000, 3000);
    if (r1.kind !== "added") throw new Error("expected add");
    expect(tap(r1.project, st, 1100, 9000).kind).toBe("none");
    expect(tap(r1.project, st, 2000, 5000).kind).toBe("added");
  });
  it("reports a full list", () => {
    const capped = { ...base, markers: { ...base.markers, custom: Array.from({ length: 2000 }, (_, i) => ({ id: `k${i}`, ms: i, label: "" })) } };
    expect(tap(capped, { lastAt: -Infinity }, 1000, 5000).kind).toBe("full");
  });
  it("nearestCustom respects reach", () => {
    const p = { ...base, markers: { ...base.markers, custom: [{ id: "a", ms: 1000, label: "" }, { id: "b", ms: 1100, label: "" }] } };
    expect(nearestCustom(p, 1090)?.id).toBe("b");
    expect(nearestCustom(p, 1400)).toBeNull();
  });
});

describe("hit testing", () => {
  const list = [mk("a", "word", 1000, { endMs: 2000 }), mk("b", "word", 2000, { endMs: 2500 })];
  it("hits the nearest tick within 6 px", () => {
    // pps 100: 1000 ms = x 100
    expect(hitTest(list, 103, 100, 0)?.id).toBe("a");
    expect(hitTest(list, 197, 100, 0)?.id).toBe("b");
  });
  it("hits inside a range, narrowest first", () => {
    expect(hitTest(list, 150, 100, 0)?.id).toBe("a");
    expect(hitTest(list, 20, 100, 0)).toBeNull();
    const nested = [mk("outer", "phrase", 0, { endMs: 5000 }), mk("inner", "phrase", 1000, { endMs: 2000 })];
    expect(hitTest(nested, 150, 100, 0)?.id).toBe("inner");
  });
  it("scroll shifts", () => {
    expect(hitTest(list, 100, 100, 1000)?.id).toBe("b");
    expect(hitTest(list, 0, 100, 1000)?.id).toBe("a");
  });
  it("visibleMarkers keeps ranges that overlap the window", () => {
    expect(visibleMarkers(list, 2200, 3000).map((m) => m.id)).toEqual(["a", "b"].filter((i) => i === "b"));
    expect(visibleMarkers(list, 1500, 1600).map((m) => m.id)).toEqual(["a"]);
  });
  it("describes a marker", () => {
    expect(describeMarker(mk("x", "kick", 61_500, { strength: 0.5 }), formatMs)).toBe("Kick · 1:01.500 · 0.50");
  });
});

describe("export rows", () => {
  it("lists visible lanes only with song ms, end ms, bar and beat", () => {
    const m = deriveMarkers(a, base.markers, range);
    const rows = buildMarkerRows(m, base, a);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.some((r) => r.lane === "hats")).toBe(false);
    expect(rows.some((r) => r.lane === "word")).toBe(false);
    const kick = rows.find((r) => r.lane === "kick" && r.songMs === 1000);
    expect(kick).toMatchObject({ timelineMs: 1000, endMs: 0, bar: 0, beat: 2 });
    const sec = rows.find((r) => r.lane === "section" && r.songMs === 8000);
    expect(sec).toMatchObject({ endMs: 16_000, label: "chorus" });
    const shown = withLane(base, "hats", { visible: true });
    expect(buildMarkerRows(deriveMarkers(a, shown.markers, range), shown, a).some((r) => r.lane === "hats")).toBe(true);
  });
  it("timeline ms is relative to the range start", () => {
    const p = { ...base, song: { ...(base.song as NonNullable<typeof base.song>), startMs: 8000, endMs: 16_000 } };
    const rows = buildMarkerRows(deriveMarkers(a, p.markers, { startMs: 8000, endMs: 16_000 }), p, a);
    const k = rows.find((r) => r.lane === "kick");
    expect(k).toMatchObject({ timelineMs: 0, songMs: 8000 });
  });
  it("groups by lane", () => {
    const g = groupByLane(deriveMarkers(a, base.markers, range));
    expect(g.get("beat")?.length).toBe(48);
  });
});
