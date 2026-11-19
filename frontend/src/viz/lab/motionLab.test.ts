import { describe, expect, it } from "vitest";
import { inTransitionAt } from "./motionLab";
import type { TimelineEntry } from "../types";

const entries: TimelineEntry[] = [
  { startMs: 0, endMs: 10_000, sceneId: "a", transition: { kind: "cut", ms: 0 } },
  { startMs: 10_000, endMs: 20_000, sceneId: "b", transition: { kind: "crossfade", ms: 500 } },
  { startMs: 20_000, endMs: 30_000, sceneId: "c", transition: { kind: "cut", ms: 0 } },
];

describe("inTransitionAt", () => {
  it("is true through a crossfade window", () => {
    expect(inTransitionAt(entries, 10_100, 10_117)).toBe(true);
    expect(inTransitionAt(entries, 10_483, 10_500)).toBe(true);
  });
  it("is true on the frame a hard cut lands, and the one after", () => {
    expect(inTransitionAt(entries, 19_990, 20_007)).toBe(true);
    expect(inTransitionAt(entries, 20_007, 20_023)).toBe(true);
  });
  it("is false in the middle of a scene", () => {
    expect(inTransitionAt(entries, 15_000, 15_017)).toBe(false);
    expect(inTransitionAt(entries, 25_000, 25_017)).toBe(false);
  });
});
