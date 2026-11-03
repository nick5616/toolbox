import { describe, expect, it } from "vitest";
import type { EditMarkerState } from "@/lib/api";
import { buildFixture } from "../fixture";
import { emptyEditProject, LANE_DEFAULTS } from "./defaults";
import { buildEditFixture, fixtureKicks, fixtureSnares, FIXTURE_DURATION_MS } from "./fixture";
import { barGrid, deriveLane, deriveMarkers, nearestBeat, TAP_LATENCY_MS } from "./markers";
import type { LaneSettings, MarkerLane } from "./types";

const a = buildEditFixture();
const WHOLE = { startMs: 0, endMs: FIXTURE_DURATION_MS };

function state(over: Partial<Record<MarkerLane, Partial<LaneSettings>>> = {}, extra: Partial<EditMarkerState> = {}): EditMarkerState {
  const base = emptyEditProject("9:16", 30, 1).markers;
  const lanes: Record<string, LaneSettings> = { ...LANE_DEFAULTS };
  for (const [k, v] of Object.entries(over)) lanes[k] = { ...LANE_DEFAULTS[k as MarkerLane], ...v };
  return { ...base, lanes, ...extra };
}

const lane = (ms: ReturnType<typeof deriveMarkers>, l: MarkerLane) => ms.filter((m) => m.lane === l);

function near(got: number[], want: number[], tol = 20) {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(Math.abs(g - (want[i] as number))).toBeLessThanOrEqual(tol));
}

describe("deriveMarkers lanes", () => {
  const all = deriveMarkers(a, state(), WHOLE);

  it("is sorted by (ms, lane)", () => {
    for (let i = 1; i < all.length; i++) expect((all[i] as { ms: number }).ms).toBeGreaterThanOrEqual((all[i - 1] as { ms: number }).ms);
  });

  it("kicks and snares match the truth within 20 ms", () => {
    near(lane(all, "kick").map((m) => m.ms), fixtureKicks());
    near(lane(all, "snare").map((m) => m.ms), fixtureSnares());
  });

  it("beats: strength 1 on the bar and 0.6 off it; ids keep the song ms", () => {
    const b = lane(all, "beat");
    expect(b.length).toBe(48);
    expect(b[0]).toMatchObject({ id: "beat:0", strength: 1, beatIndex: 0, bar: 0 });
    expect(b[1]).toMatchObject({ id: "beat:500", strength: 0.6, beatIndex: 1, bar: 0 });
    expect(b[4]).toMatchObject({ id: "beat:2000", strength: 1, bar: 1 });
  });

  it("downbeats are every 2 s", () => {
    expect(lane(all, "downbeat").map((m) => m.ms)).toEqual(Array.from({ length: 12 }, (_, i) => i * 2000));
  });

  it("exactly one stop in 14,000-16,000, at 15,000 +- 20 ms", () => {
    const stops = lane(all, "stop").filter((m) => m.ms >= 14_000 && m.ms <= 16_000);
    expect(stops.length).toBe(1);
    const s = stops[0] as NonNullable<(typeof stops)[number]>;
    expect(Math.abs(s.ms - 15_000)).toBeLessThanOrEqual(20);
    expect(Math.abs((s.endMs ?? 0) - 15_400)).toBeLessThanOrEqual(40);
    expect(s.strength).toBeGreaterThan(0.5);
    expect(lane(all, "stop").length).toBe(1);
  });

  it("drop event at 16,000", () => {
    const d = lane(all, "drop");
    expect(d.length).toBe(1);
    expect(Math.abs((d[0] as { ms: number }).ms - 16_000)).toBeLessThanOrEqual(20);
  });

  it("sections carry labels, ends and energy as strength", () => {
    const s = lane(all, "section");
    expect(s.map((m) => m.label)).toEqual(["intro", "verse", "chorus", "drop"]);
    expect(s[2]).toMatchObject({ id: "section:8000", ms: 8000, endMs: 16_000, strength: 0.85 });
  });

  it("phrases are the timed lines; words carry text and emphasis", () => {
    const p = lane(all, "phrase");
    expect(p.length).toBeGreaterThan(2);
    expect(p[0]).toMatchObject({ ms: 4000, strength: 1 });
    const w = lane(all, "word");
    expect(w.length).toBeGreaterThan(10);
    expect(w.some((m) => m.strength === 1)).toBe(true);
    expect(w.some((m) => m.strength === 0.7)).toBe(true);
    expect(w[0]?.label).toBeTruthy();
  });

  it("phrase without text falls back to singing runs", () => {
    const b = buildFixture({ durationMs: 24_000, words: false, stems: true });
    const p = deriveLane(b, state(), "phrase", WHOLE);
    // no text lines in the analysis: voiced channel is all zero in the fixture without words
    expect(p.length).toBe(0);
    // With text lines present but removed via withText(null) the voiced channel of the word fixture is used.
    const c = buildEditFixture().withText(null);
    const runs = deriveLane(c, state(), "phrase", WHOLE);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const r of runs) expect((r.endMs ?? 0) - r.ms).toBeGreaterThanOrEqual(1000);
  });

  it("bar index follows the last downbeat <= ms and is -1 before the first", () => {
    const k = lane(all, "kick");
    expect(k[0]?.bar).toBe(0);
    expect(lane(all, "snare")[0]?.bar).toBe(0);
    const shifted = deriveMarkers(a, state({}, { barOffset: 2 }), WHOLE);
    expect(lane(shifted, "kick")[0]?.bar).toBe(-1);
    expect(lane(shifted, "kick")[4]?.bar).toBe(0);
  });
});

describe("sensitive drum lanes", () => {
  it("re-pick from the stem curves below 0.1 and match the truth", () => {
    const m = deriveLane(a, state({ kick: { minStrength: 0 } }), "kick", WHOLE);
    near(m.map((x) => x.ms), fixtureKicks());
    const sn = deriveLane(a, state({ snare: { minStrength: 0.05 } }), "snare", WHOLE);
    near(sn.map((x) => x.ms), fixtureSnares());
    for (const x of m) expect(x.strength).toBeGreaterThan(0.05);
  });
  it("hats re-pick finds the eighth notes in loud sections", () => {
    const m = deriveLane(a, state({ hats: { minStrength: 0 } }), "hats", WHOLE);
    expect(m.length).toBeGreaterThan(20);
    for (let i = 1; i < m.length; i++) expect((m[i] as { ms: number }).ms - (m[i - 1] as { ms: number }).ms).toBeGreaterThanOrEqual(80);
  });
  it("without stems the lane never goes below the events", () => {
    const n = buildFixture({ durationMs: 24_000, stems: false, words: false });
    const m = deriveLane(n, state({ kick: { minStrength: 0 } }), "kick", WHOLE);
    expect(m.length).toBe(n.events("kick").length);
  });
});

describe("filters and overrides", () => {
  it("threshold: snares at 0.5 drop the quiet ones", () => {
    const lo = deriveLane(a, state({ snare: { minStrength: 0.25 } }), "snare", WHOLE).length;
    const hi = deriveLane(a, state({ snare: { minStrength: 0.7 } }), "snare", WHOLE);
    expect(hi.length).toBeLessThan(lo);
    for (const m of hi) expect(m.strength).toBeGreaterThanOrEqual(0.7);
  });

  it("every N keeps index % N == 0", () => {
    const base = deriveLane(a, state({ kick: { minStrength: 0.25 } }), "kick", WHOLE);
    const every = deriveLane(a, state({ kick: { minStrength: 0.25, every: 3 } }), "kick", WHOLE);
    expect(every.map((m) => m.id)).toEqual(base.filter((_, i) => i % 3 === 0).map((m) => m.id));
  });

  it("first of bar keeps one marker per bar, before every", () => {
    const f = deriveLane(a, state({ kick: { firstOfBar: true } }), "kick", WHOLE);
    expect(f.length).toBeGreaterThan(5);
    expect(new Set(f.map((m) => m.bar)).size).toBe(f.length);
    const fe = deriveLane(a, state({ kick: { firstOfBar: true, every: 2 } }), "kick", WHOLE);
    expect(fe.map((m) => m.id)).toEqual(f.filter((_, i) => i % 2 === 0).map((m) => m.id));
  });

  it("nudge shifts ms but not the id", () => {
    const base = deriveLane(a, state(), "snare", WHOLE);
    const n = deriveLane(a, state({ snare: { nudgeMs: -30 } }), "snare", WHOLE);
    // -30 puts the first snare (500) at 470; earlier ones stay in
    expect(n.map((m) => m.id)).toEqual(base.map((m) => m.id));
    expect(n[1]?.ms).toBe((base[1]?.ms ?? 0) - 30);
  });

  it("bar offset shifts the downbeat phase and the bar starts", () => {
    const d1 = deriveLane(a, state({}, { barOffset: 1 }), "downbeat", WHOLE);
    expect(d1.map((m) => m.ms).slice(0, 3)).toEqual([500, 2500, 4500]);
    expect(d1[0]?.bar).toBe(0);
    expect(d1[0]?.beatIndex).toBe(1);
    expect(barGrid(a, 3).starts[0]).toBe(1500);
    expect(barGrid(a, 4).starts[0]).toBe(0); // wraps
  });

  it("beat strength follows the offset", () => {
    const b = deriveLane(a, state({}, { barOffset: 1 }), "beat", WHOLE);
    expect(b[0]?.strength).toBe(0.6);
    expect(b[1]?.strength).toBe(1);
  });

  it("hidden and moved overrides apply, and survive a threshold change", () => {
    const id = "snare:1500";
    const hidden = deriveLane(a, state({}, { hidden: [id] }), "snare", WHOLE);
    expect(hidden.some((m) => m.id === id)).toBe(false);
    const moved = deriveLane(a, state({}, { moved: { [id]: 1620 }, hidden: [] }), "snare", WHOLE);
    const m = moved.find((x) => x.id === id);
    expect(m).toMatchObject({ ms: 1620, moved: true });
    // a high threshold removes the marker, the state keeps the override, lowering it brings it back
    const st = state({ snare: { minStrength: 0.6 } }, { moved: { [id]: 1620 }, hidden: ["snare:2500"] });
    expect(deriveLane(a, st, "snare", WHOLE).some((x) => x.id === id)).toBe(false);
    const back = deriveLane(a, { ...st, lanes: { ...st.lanes, snare: LANE_DEFAULTS.snare } }, "snare", WHOLE);
    expect(back.find((x) => x.id === id)?.ms).toBe(1620);
    expect(back.some((x) => x.id === "snare:2500")).toBe(false);
  });

  it("moved ignores nudge", () => {
    const m = deriveLane(a, state({ snare: { nudgeMs: 50 } }, { moved: { "snare:1500": 1600 } }), "snare", WHOLE).find((x) => x.id === "snare:1500");
    expect(m?.ms).toBe(1600);
  });

  it("section labels come from the state", () => {
    const m = deriveLane(a, state({}, { labels: { "section:8000": "Hook" } }), "section", WHOLE);
    expect(m.find((x) => x.id === "section:8000")?.label).toBe("Hook");
    expect(m[0]?.label).toBe("intro");
  });

  it("custom markers skip the filters and are in timeline ms", () => {
    const st = state({ custom: { minStrength: 0.9, every: 5 } }, { custom: [{ id: "k1", ms: 1234, label: "hit" }, { id: "k2", ms: 5000, label: "" }] });
    const c = deriveLane(a, st, "custom", WHOLE);
    expect(c).toEqual([
      { id: "k1", lane: "custom", ms: 1234, strength: 1, bar: 0, label: "hit" },
      { id: "k2", lane: "custom", ms: 5000, strength: 1, bar: 2 },
    ]);
  });
});

describe("range clipping", () => {
  const range = { startMs: 8000, endMs: 16_000 };
  const m = deriveMarkers(a, state(), range);

  it("converts to timeline ms and keeps song-ms ids", () => {
    const k = lane(m, "kick");
    expect(k[0]).toMatchObject({ id: "kick:8000", ms: 0 });
    for (const x of m) {
      expect(x.ms).toBeGreaterThanOrEqual(0);
      expect(x.ms).toBeLessThan(8000);
    }
  });

  it("a stop at 15,000 is at 7,000", () => {
    const s = lane(m, "stop")[0];
    expect(Math.abs((s?.ms ?? 0) - 7000)).toBeLessThanOrEqual(20);
  });

  it("the drop at 16,000 is outside [8000,16000)", () => {
    expect(lane(m, "drop").length).toBe(0);
  });

  it("sections overlapping the range are clamped to it", () => {
    const part = deriveMarkers(a, state(), { startMs: 6000, endMs: 10_000 });
    const sec = lane(part, "section");
    expect(sec.map((s) => s.id)).toEqual(["section:4000", "section:8000"]);
    expect(sec[0]).toMatchObject({ ms: 0, endMs: 2000 });
    expect(sec[1]).toMatchObject({ ms: 2000, endMs: 4000 });
  });

  it("every N and bar indices do not depend on the range", () => {
    const st = state({ kick: { every: 3 } });
    const whole = deriveLane(a, st, "kick", WHOLE);
    const part = deriveLane(a, st, "kick", range);
    expect(part.map((x) => x.id)).toEqual(whole.filter((x) => x.ms >= 8000 && x.ms < 16_000).map((x) => x.id));
    expect(part[0]?.bar).toBe(whole.find((x) => x.id === part[0]?.id)?.bar);
  });
});

describe("helpers", () => {
  it("tap latency is 40 ms", () => expect(TAP_LATENCY_MS).toBe(40));
  it("nearestBeat", () => {
    expect(nearestBeat(a, 740)).toEqual({ ms: 500, index: 1 });
    expect(nearestBeat(a, 800)).toEqual({ ms: 1000, index: 2 });
    expect(nearestBeat(a, -50)).toEqual({ ms: 0, index: 0 });
  });
});

describe("benchmark", () => {
  it("derives every lane of a 4-minute, 60 fps analysis in < 30 ms", () => {
    const big = buildFixture({ durationMs: 240_000, fps: 60, stems: true, words: true });
    const st = state({ kick: { minStrength: 0 }, snare: { minStrength: 0 }, hats: { minStrength: 0 } });
    const range = { startMs: 0, endMs: 240_000 };
    deriveMarkers(big, st, range); // warm up (channel decoding caches)
    // Best of 5: the suite runs files in parallel, and a single run can be preempted.
    let ms = Infinity;
    let out = deriveMarkers(big, st, range);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      out = deriveMarkers(big, st, range);
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(out.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(30);
  });
});
