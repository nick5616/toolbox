/** Phase 21 V1 (SPEC section C2): envelope classes, the energy ramp, master intensity, palette hysteresis, calmer posts. */
import { describe, expect, it } from "vitest";
import { buildFixture } from "./fixture";
import { drive } from "./layers/_bg/util";
import { eventsIn, FLASH_MIN_STRENGTH, triggerList } from "./layers/_triggers";
import type { FrameInput } from "./layers/registry";
import { CHORD_MAX_TURNS, chordAccentTurns, MOOD_BLEND_MS, MOOD_HOLD_BARS, MOOD_WHEEL, moodPaletteChanges, paletteById, resolvePalette, wheelStep } from "./palette";
import { chromaticPx, flashLevel, SHAKE_HZ, SHAKE_MAX_FRACTION, shakeOffset, zoomPulseScale, ZOOM_PULSE_MAX } from "./post/px1math";
import { postDef } from "./post/registry";
import "./post";
import { evalParam, Signals, SIGNAL_CLASS_DEFAULTS, signalClass, type ModContext } from "./signals";
import type { Emotion, Mod, SignalId } from "./types";

const BAR = 2000;

describe("envelope classes", () => {
  it("classifies every signal", () => {
    const pulse: SignalId[] = ["kick", "snare", "hats", "beat.pulse", "bar.pulse", "bass.onset", "vocals.onset", "mix.onset", "drop.pulse", "word.pulse"];
    const level: SignalId[] = ["bass.level", "drums.level", "vocals.level", "other.level", "mix.level", "mix.bass", "mix.presence", "mix.brightness"];
    const slow: SignalId[] = ["section.energy", "mood.valence", "mood.energy", "line.active"];
    for (const id of pulse) expect(signalClass(id), id).toBe("pulse");
    for (const id of level) expect(signalClass(id), id).toBe("level");
    for (const id of slow) expect(signalClass(id), id).toBe("slow");
    expect(SIGNAL_CLASS_DEFAULTS.pulse).toEqual({ attackMs: 10, releaseMs: 180 });
    expect(SIGNAL_CLASS_DEFAULTS.level).toEqual({ attackMs: 60, releaseMs: 400 });
    expect(SIGNAL_CLASS_DEFAULTS.slow).toEqual({ attackMs: 600, releaseMs: 1500 });
  });

  it("uses a mod's class when it sets no envelope, and its own when it does", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const sig = new Signals(a);
    const mc: ModContext = { signals: sig, mix: { drums: 1, bass: 1, vocals: 1, other: 1, words: 1, mood: 1 }, reactivity: 1 };
    const mod = (patch: Partial<Mod>): Mod => ({ signal: "bass.level", amount: 1, shape: "linear", ...patch }) as Mod;
    const t = 14_000;
    const cls = SIGNAL_CLASS_DEFAULTS.level;
    expect(evalParam({ base: 0, mods: [mod({})] }, 0, 1, t, mc)).toBeCloseTo(Math.max(0, Math.min(1, sig.value("bass.level", t, cls.attackMs, cls.releaseMs))), 9);
    expect(evalParam({ base: 0, mods: [mod({ attackMs: 5, releaseMs: 50 })] }, 0, 1, t, mc)).toBeCloseTo(Math.max(0, Math.min(1, sig.value("bass.level", t, 5, 50))), 9);
    const slow = SIGNAL_CLASS_DEFAULTS.slow;
    expect(evalParam({ base: 0, mods: [mod({ signal: "section.energy" })] }, 0, 1, t, mc)).toBeCloseTo(sig.value("section.energy", t, slow.attackMs, slow.releaseMs), 9);
    expect(sig.smoothed("mix.level", t)).toBe(sig.value("mix.level", t, cls.attackMs, cls.releaseMs));
  });

  it("falls back to the mix's low-band level for the drums without stems", () => {
    const a = buildFixture({ durationMs: 30_000, stems: false });
    const sig = new Signals(a);
    expect(a.has("drums.level")).toBe(false);
    expect(Array.from(sig.get("drums.level"))).toEqual(Array.from(a.channel("mix.bass") ?? []));
  });
});

describe("section energy ramps", () => {
  const a = buildFixture({
    durationMs: 120_000,
    sections: [
      [0, "intro", "A", 0.2],
      [20_000, "verse", "B", 0.8],
      [60_000, "chorus", "C", 0.4],
    ],
  });
  const sig = new Signals(a);
  const e = (t: number) => sig.value("section.energy", t);
  const fps = a.fps;

  it("moves linearly over one bar centred on the boundary, never as a step", () => {
    expect(e(18_000 - 100)).toBeCloseTo(0.2, 2);
    expect(e(19_000)).toBeCloseTo(0.2, 2); // one bar is 2 s: the ramp starts half a bar before
    expect(e(20_000)).toBeCloseTo(0.5, 2); // halfway
    expect(e(20_500)).toBeCloseTo(0.5 + (0.3 * 0.5) / 1, 1);
    expect(e(21_000)).toBeCloseTo(0.8, 2);
    expect(e(40_000)).toBeCloseTo(0.8, 6);
    expect(e(60_000)).toBeCloseTo(0.6, 2);
    let maxStep = 0;
    for (let t = 17_000; t < 23_000; t += 1000 / fps) maxStep = Math.max(maxStep, Math.abs(e(t + 1000 / fps) - e(t)));
    expect(maxStep).toBeLessThan(0.6 / (fps * 2) + 0.01); // a 0.6 step spread over a 2 s ramp
  });
});

describe("master intensity", () => {
  function input(intensity: number): FrameInput {
    const analysis = buildFixture({ durationMs: 30_000 });
    return {
      tMs: 10_000,
      dtMs: 16,
      motionSec: 10,
      params: {},
      opacity: 1,
      palette: paletteById("cyber"),
      analysis,
      signals: new Signals(analysis),
      w: 1280,
      h: 720,
      seed: 1,
      quality: "full",
      mode: "opaque",
      intensity,
      integral: () => 0,
      beatIntegral: () => 0,
    };
  }

  it("scales every built-in reaction of a layer", () => {
    const one = drive(input(1), 1);
    const half = drive(input(0.5), 1);
    const off = drive(input(0), 1);
    expect(one.bass).toBeGreaterThan(0);
    expect(half.bass).toBeCloseTo(one.bass * 0.5, 9);
    expect(half.kick).toBeCloseTo(one.kick * 0.5, 9);
    expect(off.bass).toBe(0);
    expect(off.drop).toBe(0);
    expect(off.beat).toBe(0);
  });

  it("scales the flash transition and the posts that read signals", () => {
    expect(flashLevel(0, 0.5)).toBeCloseTo(0.5, 9);
    expect(flashLevel(0, 1)).toBeCloseTo(1, 9);
    expect(flashLevel(0, 0)).toBe(0);
  });
});

describe("calmer posts", () => {
  it("shakes at 5 Hz and at most 1% of the short side", () => {
    expect(SHAKE_HZ).toBe(5);
    expect(SHAKE_MAX_FRACTION).toBe(0.01);
    let big = 0;
    let step = 0;
    let prev = shakeOffset(0, 3, 1, 720, 1);
    for (let t = 1000 / 60; t < 20_000; t += 1000 / 60) {
      const o = shakeOffset(t, 3, 1, 720, 1);
      big = Math.max(big, Math.abs(o[0]), Math.abs(o[1]));
      step = Math.max(step, Math.abs(o[0] - prev[0]));
      prev = o;
    }
    expect(big).toBeLessThanOrEqual(7.2 + 1e-9);
    // at 24 Hz neighbouring frames could differ by most of the amplitude; at 5 Hz they differ by a small part of it
    expect(step).toBeLessThan(0.45 * 7.2);
  });

  it("pulses the zoom on bars, by at most 3%", () => {
    expect(ZOOM_PULSE_MAX).toBe(0.03);
    expect(zoomPulseScale(1, 1)).toBeCloseTo(1.03, 9);
    const p = postDef("zoompulse")?.params.trigger;
    expect(p && p.kind === "enum" && p.default).toBe("bar");
  });

  it("splits colour on drops by default, and the flash peaks at 1.0", () => {
    const p = postDef("chromatic")?.params.source;
    expect(p && p.kind === "enum" && p.default).toBe("drop");
    expect(chromaticPx(4, 1, 720)).toBeCloseTo(4, 9);
    expect(flashLevel(0)).toBeCloseTo(1, 9);
  });

  it("rings the shockwave every four bars without a flash, and flashes only on drops", () => {
    const a = buildFixture({ durationMs: 60_000 });
    a.audio.events.drop = [[30_000, 255]];
    const list = triggerList(a, "drop+downbeat");
    const bars = list.filter((e) => e[1] < 255);
    expect(bars.length).toBeGreaterThan(0);
    for (const e of bars) expect(e[1]).toBeLessThan(FLASH_MIN_STRENGTH);
    expect(list.some((e) => e[0] === 30_000 && e[1] >= FLASH_MIN_STRENGTH)).toBe(true);
    const downbeats = a.audio.downbeats;
    const gaps = bars.slice(1).map((e, i) => (downbeats.indexOf(e[0]) - downbeats.indexOf((bars[i] as [number, number])[0])) | 0);
    for (const g of gaps) expect(g).toBe(4);
    expect(eventsIn(list, -1, 60_000).length).toBe(list.length);
  });
});

function barDistance(a: number, b: number): number {
  return Math.abs(a - b) / BAR;
}

describe("palette hysteresis", () => {
  it("chords rotate only the accents, by at most 30 degrees, and only after a chord has held two beats", () => {
    const a = buildFixture({ durationMs: 60_000 });
    a.audio.chords.splice(
      0,
      a.audio.chords.length,
      { startMs: 0, endMs: 4_000, name: "C", root: 0, minor: false },
      { startMs: 4_000, endMs: 4_700, name: "G", root: 7, minor: false }, // 700 ms: less than two beats (1000 ms), never counts
      { startMs: 4_700, endMs: 10_000, name: "D", root: 2, minor: false },
    );
    const cfg = { mode: "chords" as const, ids: ["cyber" as const] };
    const base = paletteById("cyber");
    for (let t = 0; t < 12_000; t += 250) {
      const p = resolvePalette(cfg, a, t);
      expect(p.bg).toEqual(base.bg);
      expect(p.colors).toEqual(base.colors);
    }
    let worst = 0;
    for (let t = 0; t < 12_000; t += 50) {
      const turns = chordAccentTurns(a, t);
      worst = Math.max(worst, Math.abs(turns));
    }
    expect(worst).toBeLessThanOrEqual(CHORD_MAX_TURNS + 1e-9);
    expect(worst).toBeGreaterThan(0);
    // nothing counts before the first chord has held two beats; the 700 ms chord never counts
    expect(chordAccentTurns(a, 500)).toBe(0);
    expect(chordAccentTurns(a, 4_900)).toBeCloseTo(chordAccentTurns(a, 4_700), 12); // still C's colour: G was too short
    // a glide never exceeds the ramp rate: one bar for at most 60 degrees between two chords
    let fast = 0;
    for (let t = 0; t < 12_000; t += 1000 / 60) fast = Math.max(fast, Math.abs(chordAccentTurns(a, t + 1000 / 60) - chordAccentTurns(a, t)));
    expect(fast).toBeLessThan((2 * CHORD_MAX_TURNS) / (BAR / (1000 / 60)) * 2);
  });

  it("the mood palette holds eight bars and only moves to a neighbour on the wheel", () => {
    const a = buildFixture({ durationMs: 200_000 });
    const far: Emotion[] = ["joy", "anger", "sadness", "awe", "calm", "fear"];
    if (a.text) a.text.mood = Array.from({ length: 60 }, (_, i) => ({ ms: i * 3_000, valence: 0, energy: 0.5, emotion: far[i % far.length] as Emotion }));
    const changes = moodPaletteChanges(a);
    expect(changes.length).toBeGreaterThan(2);
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1] as { ms: number; emotion: Emotion };
      const cur = changes[i] as { ms: number; emotion: Emotion };
      expect(cur.ms - prev.ms).toBeGreaterThanOrEqual(MOOD_HOLD_BARS * BAR);
      const d = Math.abs(MOOD_WHEEL.indexOf(cur.emotion) - MOOD_WHEEL.indexOf(prev.emotion));
      expect(Math.min(d, MOOD_WHEEL.length - d)).toBe(1);
    }
    expect(wheelStep("joy", "anger")).not.toBe("anger");
    expect(wheelStep("joy", "hope")).toBe("hope");
    expect(MOOD_BLEND_MS).toBe(4000);
    expect(barDistance(0, BAR)).toBe(1);
    // the blend lasts four seconds: halfway, the palette is between the two
    const cfg = { mode: "mood" as const, ids: ["cyber" as const] };
    const second = changes[1] as { ms: number };
    const before = resolvePalette(cfg, a, second.ms - 10);
    const after = resolvePalette(cfg, a, second.ms + MOOD_BLEND_MS + 10);
    const mid = resolvePalette(cfg, a, second.ms + MOOD_BLEND_MS / 2);
    expect(mid.accent).not.toEqual(before.accent);
    expect(mid.accent).not.toEqual(after.accent);
  });
});
