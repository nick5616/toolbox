import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import type { Marker } from "@/viz/edit/types";
import { buildSnapTargets, snapPoint, snapSpan, snapThresholdMs } from "./snapping";

const mk = (lane: Marker["lane"], ms: number): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1 });
const project = normalizeProject(fixtureProject());

describe("snapping", () => {
  it("collects markers of visible lanes, clip edges, playhead, 0 and D (sorted)", () => {
    const t = buildSnapTargets({ project, markers: [mk("kick", 500), mk("hats", 700), mk("downbeat", 2000)], playheadMs: 1234 });
    const labels = t.map((x) => `${x.ms}:${x.label}`);
    expect(labels).toContain("500:kick");
    expect(labels).toContain("2000:downbeat");
    expect(labels).not.toContain("700:hats"); // hats hidden by default
    expect(labels).toContain("1234:playhead");
    expect(labels).toContain("0:start");
    expect(labels).toContain("24000:end");
    expect(labels).toContain("8000:clip edge");
    expect(t.map((x) => x.ms)).toEqual([...t.map((x) => x.ms)].sort((a, b) => a - b));
  });
  it("leaves out the dragged clips' own edges", () => {
    const t = buildSnapTargets({ project, markers: [], playheadMs: 0, exclude: new Set(["c2"]) });
    expect(t.some((x) => x.label === "clip edge" && x.ms === 16_000)).toBe(true); // c3's start still there
    expect(t.filter((x) => x.ms === 8000 && x.label === "clip edge")).toHaveLength(1); // c1's end only
  });
  it("snaps within 8 px and not beyond", () => {
    const targets = [{ ms: 1000, label: "kick" }, { ms: 2000, label: "snare" }];
    expect(snapThresholdMs(100)).toBe(80);
    expect(snapPoint(1070, targets, 100)?.label).toBe("kick");
    expect(snapPoint(1090, targets, 100)).toBeNull();
    expect(snapPoint(1950, targets, 100)?.label).toBe("snare");
    expect(snapPoint(10, [], 100)).toBeNull();
  });
  it("zoom changes the threshold", () => {
    const targets = [{ ms: 1000, label: "kick" }];
    expect(snapPoint(1040, targets, 400)).toBeNull(); // 20 ms limit
    expect(snapPoint(1015, targets, 400)?.ms).toBe(1000);
  });
  it("snaps a span by its nearer edge", () => {
    const targets = [{ ms: 1000, label: "kick" }, { ms: 3000, label: "snare" }];
    expect(snapSpan(1030, 2500, targets, 100)).toMatchObject({ deltaMs: -30, target: { label: "kick" } });
    expect(snapSpan(1500, 2960, targets, 100)).toMatchObject({ deltaMs: 40, target: { label: "snare" } });
    expect(snapSpan(1500, 2500, targets, 100).target).toBeNull();
  });
});
