import { describe, expect, it } from "vitest";
import { Signals } from "../signals";
import { emptyEditProject } from "./defaults";
import { buildEditFixture, FIXTURE_DURATION_MS } from "./fixture";
import { MarkerSignals } from "./markerSignals";
import { deriveMarkers } from "./markers";

const a = buildEditFixture();
const markers = deriveMarkers(a, emptyEditProject("9:16", 30, 1).markers, { startMs: 0, endMs: FIXTURE_DURATION_MS });
const ms = new MarkerSignals(a, markers, 0);

describe("MarkerSignals", () => {
  it("kick pulses peak at the marker and decay with tau 90", () => {
    const at = ms.value("kick", {}, 1000);
    expect(at).toBeCloseTo(0.6, 2); // the kick's own strength (intro energy 0.2)
    const later = ms.value("kick", {}, 1090);
    expect(later).toBeCloseTo(at * Math.exp(-1), 1);
    expect(ms.value("kick", {}, 1240)).toBeLessThan(0.1);
  });

  it("matches Signals.kick (same events, same tau) away from the stop", () => {
    const s = new Signals(a);
    for (const t of [1000, 1030, 2060, 5000, 9990]) expect(ms.value("kick", {}, t)).toBeCloseTo(s.value("kick", t), 1);
  });

  it("beat and downbeat use strength 1 and their taus", () => {
    expect(ms.value("beat", {}, 500)).toBeCloseTo(1, 1);
    expect(ms.value("beat", {}, 620)).toBeCloseTo(Math.exp(-1), 1);
    expect(ms.value("downbeat", {}, 2300)).toBeCloseTo(Math.exp(-1), 1);
  });

  it("every keeps every Nth marker", () => {
    // kicks at 0, 500, 1000...: every 4 keeps 0, 2000, 4000
    const f = { every: 4 };
    expect(ms.value("kick", f, 2000)).toBeGreaterThan(0.5);
    expect(ms.value("kick", f, 2500)).toBeLessThan(0.05);
    expect(ms.value("kick", {}, 2500)).toBeGreaterThan(0.5);
    expect(ms.filtered("kick", f).length).toBe(Math.ceil(ms.filtered("kick", {}).length / 4));
  });

  it("sections filter keeps markers inside those sections", () => {
    const f = { sections: ["chorus" as const] };
    expect(ms.value("kick", f, 9000)).toBeGreaterThan(0.9);
    expect(ms.value("kick", f, 5000)).toBe(0);
    expect(ms.value("kick", { sections: ["verse" as const] }, 5000)).toBeGreaterThan(0.7);
  });

  it("stop is a gate over [ms, endMs)", () => {
    expect(ms.value("stop", {}, 14_900)).toBe(0);
    expect(ms.value("stop", {}, 15_200)).toBe(1);
    expect(ms.value("stop", {}, 15_600)).toBe(0);
  });

  it("lift ramps up over two bars, then decays with tau 2000", () => {
    const lm = [{ id: "lift:10000", lane: "lift" as const, ms: 10_000, strength: 1 }];
    const m = new MarkerSignals(a, lm, 0);
    expect(m.value("lift", {}, 6000)).toBeCloseTo(0, 1); // two 2 s bars before
    expect(m.value("lift", {}, 8000)).toBeCloseTo(0.5, 1);
    expect(m.value("lift", {}, 9990)).toBeGreaterThan(0.95);
    expect(m.value("lift", {}, 12_000)).toBeCloseTo(Math.exp(-1), 1);
  });

  it("drop decays with tau 1200", () => {
    expect(ms.value("drop", {}, 16_000)).toBeGreaterThan(0.95);
    expect(ms.value("drop", {}, 17_200)).toBeCloseTo(Math.exp(-1), 1);
  });

  it("a lane with no markers is 0; song start shifts the timeline", () => {
    expect(ms.value("break", {}, 5000)).toBe(0);
    const part = deriveMarkers(a, emptyEditProject("9:16", 30, 1).markers, { startMs: 8000, endMs: 16_000 });
    const m = new MarkerSignals(a, part, 8000);
    expect(m.value("kick", {}, 9000)).toBeGreaterThan(0.9);
    expect(m.value("kick", {}, 4000)).toBe(0); // outside the range
  });

  it("attack/release follows Signals.envelope's formula and is cached", () => {
    const raw = ms.get("kick", {});
    const env = ms.envelope("kick", {}, 10, 180);
    expect(ms.envelope("kick", {}, 10, 180)).toBe(env);
    // one-pole check at a frame
    const fps = a.fps;
    const ka = Math.exp(-1000 / (fps * 10));
    const kr = Math.exp(-1000 / (fps * 180));
    let v = raw[0] as number;
    for (let i = 0; i < 100; i++) {
      const x = raw[i] as number;
      v = x + (v - x) * (x > v ? ka : kr);
      expect(env[i]).toBeCloseTo(v, 6);
    }
    expect(ms.value("kick", {}, 1000, 10, 180)).toBeCloseTo(ms.value("kick", {}, 1000, 10, 180), 6);
    // slow release keeps the value up longer than the raw pulse
    expect(ms.value("kick", {}, 1200, 10, 1000)).toBeGreaterThan(ms.value("kick", {}, 1200));
    expect(ms.get("kick", {})).toBe(raw); // series cached
  });
});
