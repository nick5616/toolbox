import { describe, expect, it } from "vitest";
import type { EditMarkerState } from "@/lib/api";
import { buildFixture } from "../fixture";
import { emptyEditProject } from "./defaults";
import { beatGrid, deriveLane } from "./markers";

const state = (): EditMarkerState => emptyEditProject("9:16", 30, 1).markers;

describe("beat grid completion", () => {
  it("continues the grid into a beatless intro and outro, marked estimated", () => {
    const a = buildFixture({ durationMs: 20_000 });
    // The tracker found beats only from 4 s to 16 s.
    (a.audio as { beats: number[] }).beats = a.audio.beats.filter((t) => t >= 4000 && t < 16_000);
    const g = beatGrid(a);
    expect(g.times[0]).toBe(0);
    expect(g.times[g.times.length - 1]).toBe(19_500);
    expect(g.times.length).toBe(40);
    expect(g.estimated.has(0)).toBe(true);
    expect(g.estimated.has(8)).toBe(false);
    const beats = deriveLane(a, state(), "beat", { startMs: 0, endMs: 20_000 });
    expect(beats.length).toBe(40);
    expect(beats[0]?.strength).toBeLessThan(1);
  });

  it("fills long gaps inside the song and leaves a complete grid alone", () => {
    const a = buildFixture({ durationMs: 20_000 });
    (a.audio as { beats: number[] }).beats = a.audio.beats.filter((t) => t < 8000 || t >= 10_000);
    expect(beatGrid(a).times).toContain(9000);
    const b = buildFixture({ durationMs: 20_000 });
    expect(beatGrid(b).times).toEqual(b.audio.beats);
    expect(beatGrid(b).estimated.size).toBe(0);
  });
});

describe("drops after stops", () => {
  it("adds a drop at the downbeat after a stop when the low end comes back stronger", () => {
    // Bars of 2 s: quiet low end in bar 8 (14-16 s) with a stop at 15.5-16 s, loud from 16 s.
    const a = buildFixture({
      durationMs: 24_000,
      sections: [
        [0, "intro", "A", 0.15],
        [16_000, "chorus", "B", 1],
      ],
      silences: [[15_500, 16_000]],
    });
    (a.audio.events as Record<string, unknown>).drop = [];
    const drops = deriveLane(a, state(), "drop", { startMs: 0, endMs: 24_000 });
    expect(drops.map((d) => d.ms)).toEqual([16_000]);
  });
});

describe("accents", () => {
  it("finds the stand-out hits of the fixture and keeps them 250 ms apart", async () => {
    const { buildEditFixture } = await import("./fixture");
    const { deriveMarkers } = await import("./markers");
    const { LANE_DEFAULTS } = await import("./defaults");
    const a = buildEditFixture();
    const lanes = { ...LANE_DEFAULTS };
    const ms = deriveMarkers(a, { lanes, barOffset: 0, hidden: [], moved: {}, labels: {}, custom: [] }, { startMs: 0, endMs: a.durationMs });
    const acc = ms.filter((m) => m.lane === "accent");
    expect(acc.length).toBeGreaterThan(0);
    // the drop at 16 s is an accent
    expect(acc.some((m) => Math.abs(m.ms - 16_000) < 300)).toBe(true);
    for (let i = 1; i < acc.length; i++) expect((acc[i] as { ms: number }).ms - (acc[i - 1] as { ms: number }).ms).toBeGreaterThanOrEqual(250);
  });
});
