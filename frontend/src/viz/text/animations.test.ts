import { describe, expect, it } from "vitest";
import {
  easeOutBack,
  emphasisEnv,
  fadesFor,
  karaokeProgress,
  lineAlpha,
  lineTiming,
  popScale,
  promotion,
  riseOffset,
  selectLines,
  sparkAt,
  SPARK_LIFE_MS,
  titleCardAlpha,
  typedChars,
  typewriterReveal,
  waveEnvelope,
  wordAnim,
  type WordTiming,
} from "./animations";

const lines = [
  { startMs: 10_000, endMs: 13_000 },
  { startMs: 13_300, endMs: 16_000 }, // 300 ms after the first: contiguous
  { startMs: 22_000, endMs: 25_000 }, // 6 s later: separate
];
const word: WordTiming = { startMs: 1000, endMs: 1400, index: 2, chars: 8 };

describe("easing", () => {
  it("overshoots then settles", () => {
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(easeOutBack(1)).toBeCloseTo(1);
    expect(Math.max(...[0.4, 0.5, 0.6, 0.7].map((x) => easeOutBack(x)))).toBeGreaterThan(1.05);
  });
  it("pop scale overshoots within 120 ms and is exactly 1 afterwards", () => {
    expect(popScale(-10)).toBeCloseTo(0.55);
    expect(popScale(0)).toBeCloseTo(0.55);
    expect(Math.max(...[40, 60, 80, 100].map(popScale))).toBeGreaterThan(1.02);
    expect(popScale(120)).toBe(1);
    expect(popScale(5000)).toBe(1);
  });
});

describe("line timing", () => {
  it("fades a separate line in before it starts and out after it ends", () => {
    const f = fadesFor("karaoke");
    const tm = lineTiming(lines, 2, f);
    expect(tm.showFromMs).toBe(22_000 - f.inMs);
    expect(lineAlpha(tm.showFromMs - 1, tm)).toBe(0);
    expect(lineAlpha(22_000 - f.inMs / 2, tm)).toBeGreaterThan(0);
    expect(lineAlpha(22_000, tm)).toBe(1);
    expect(lineAlpha(24_999, tm)).toBe(1);
    expect(lineAlpha(25_000 + f.outMs / 2, tm)).toBeGreaterThan(0);
    expect(lineAlpha(25_000 + f.outMs / 2, tm)).toBeLessThan(1);
    expect(lineAlpha(25_000 + f.outMs, tm)).toBe(0);
  });
  it("switches contiguous lines without a fade between them", () => {
    const f = fadesFor("karaoke");
    const a = lineTiming(lines, 0, f);
    const b = lineTiming(lines, 1, f);
    expect(a.fadeOutMs).toBe(0);
    expect(b.fadeInMs).toBe(0);
    expect(a.holdUntilMs).toBe(b.showFromMs);
    expect(lineAlpha(b.showFromMs - 1, a)).toBe(1);
    expect(lineAlpha(b.showFromMs, a)).toBe(0);
    expect(lineAlpha(b.showFromMs, b)).toBe(1);
  });
  it("selects the right line, and the next one when asked", () => {
    expect(selectLines(lines, 5000, "karaoke", true).main).toBeNull();
    const s = selectLines(lines, 11_000, "karaoke", true);
    expect(s.main?.index).toBe(0);
    expect(s.next?.index).toBe(1);
    expect(selectLines(lines, 11_000, "karaoke", false).next).toBeNull();
    expect(selectLines(lines, 11_000, "subtitle", true).next).toBeNull();
    expect(selectLines(lines, 14_000, "karaoke", true).main?.index).toBe(1);
    // the third line is 6 s after the second one ends: not shown as "next" until it is close
    expect(selectLines(lines, 14_000, "karaoke", true).next).toBeNull();
    expect(selectLines(lines, 17_000, "karaoke", true).main).toBeNull();
    expect(selectLines(lines, 21_000, "karaoke", true).main).toBeNull();
    expect(selectLines(lines, 23_000, "karaoke", true).main?.index).toBe(2);
    expect(selectLines([], 1000, "karaoke", true).main).toBeNull();
  });
  it("promotes a line to the main slot over 220 ms", () => {
    const tm = lineTiming(lines, 1, fadesFor("karaoke"));
    expect(promotion(tm.showFromMs, tm)).toBe(0);
    expect(promotion(tm.showFromMs + 110, tm)).toBeCloseTo(0.5);
    expect(promotion(tm.showFromMs + 400, tm)).toBe(1);
  });
  it("slides a rise line up by 3% and a little more on the way out", () => {
    const tm = lineTiming(lines, 2, fadesFor("rise"));
    expect(riseOffset(tm.showFromMs, tm)).toBeCloseTo(0.03);
    expect(riseOffset(tm.showFromMs + 2000, tm)).toBeCloseTo(0);
    expect(riseOffset(tm.holdUntilMs + 1000, tm)).toBeLessThan(0);
  });
});

describe("title card", () => {
  it("shows up to 3 s before the first line with fades", () => {
    expect(titleCardAlpha(0, 10_000)).toBe(0);
    expect(titleCardAlpha(6_750, 10_000)).toBe(0);
    expect(titleCardAlpha(6_751, 10_000)).toBeLessThan(0.01);
    expect(titleCardAlpha(8_250, 10_000)).toBe(1);
    expect(titleCardAlpha(9_749, 10_000)).toBeLessThan(0.01);
    expect(titleCardAlpha(9_800, 10_000)).toBe(0);
  });
  it("starts at 0 when the first line is early, and is skipped when there is no room", () => {
    expect(titleCardAlpha(1000, 4000)).toBeGreaterThan(0);
    expect(titleCardAlpha(0, 4000)).toBe(0); // fading in from 0
    expect(titleCardAlpha(300, 900)).toBe(0);
  });
});

describe("word animations", () => {
  it("karaoke sweeps from 0 to 1 across the word and punches at the start", () => {
    expect(karaokeProgress(900, word)).toBe(0);
    expect(karaokeProgress(1200, word)).toBeCloseTo(0.5);
    expect(karaokeProgress(2000, word)).toBe(1);
    expect(wordAnim("karaoke", 1200, word).progress).toBeCloseTo(0.5);
    expect(wordAnim("karaoke", 1001, word).scale).toBeGreaterThan(wordAnim("karaoke", 1800, word).scale);
    expect(wordAnim("karaoke", 500, word).progress).toBe(0);
  });
  it("pop hides a word until its start", () => {
    expect(wordAnim("pop", 999, word).alpha).toBe(0);
    expect(wordAnim("pop", 1060, word).alpha).toBeGreaterThan(0);
    expect(wordAnim("pop", 1500, word).scale).toBe(1);
    expect(wordAnim("pop", 1500, word).flash).toBeLessThan(0.1);
  });
  it("typewriter reveals characters between start and end", () => {
    expect(typedChars(900, word, 8)).toBe(0);
    expect(typedChars(1200, word, 8)).toBeCloseTo(4);
    expect(typedChars(5000, word, 8)).toBe(8);
    expect(wordAnim("typewriter", 1200, word).typed).toBeCloseTo(4);
    const prefix = [0, 10, 25, 30, 45];
    expect(typewriterReveal(prefix, 0)).toBe(0);
    expect(typewriterReveal(prefix, 2)).toBe(25);
    expect(typewriterReveal(prefix, 4)).toBe(45);
    expect(typewriterReveal(prefix, 1.5)).toBeGreaterThan(10);
    expect(typewriterReveal(prefix, 1.5)).toBeLessThan(25);
    expect(typewriterReveal([0], 3)).toBe(0);
  });
  it("wave bobs only while the word is sung", () => {
    expect(waveEnvelope(500, word)).toBe(0);
    expect(waveEnvelope(1200, word)).toBe(1);
    expect(waveEnvelope(3000, word)).toBe(0);
    expect(wordAnim("wave", 500, word).dy).toBe(0);
    const bob = [1100, 1150, 1200, 1250, 1300].map((t) => wordAnim("wave", t, word).dy);
    expect(Math.max(...bob) - Math.min(...bob)).toBeGreaterThan(0.05);
    expect(Math.max(...bob.map(Math.abs))).toBeLessThanOrEqual(0.2 + 1e-9);
  });
  it("rise, fade and subtitles leave words alone", () => {
    for (const p of ["rise", "fade", "subtitle", "subtitle-boxed"] as const) {
      expect(wordAnim(p, 1200, word)).toEqual({ alpha: 1, scale: 1, dy: 0, progress: -1, typed: -1, flash: 0 });
    }
  });
  it("is deterministic", () => {
    expect(wordAnim("wave", 1234, word)).toEqual(wordAnim("wave", 1234, word));
  });
});

describe("emphasis and sparks", () => {
  it("emphasis bursts at the word start and settles", () => {
    expect(emphasisEnv(999, 1000)).toBe(0);
    expect(emphasisEnv(1000, 1000)).toBeCloseTo(1);
    expect(emphasisEnv(6000, 1000)).toBeCloseTo(0.35, 2);
  });
  it("sparks are deterministic, live 900 ms and fade out", () => {
    expect(sparkAt(7, 3, -1, 2)).toBeNull();
    expect(sparkAt(7, 3, SPARK_LIFE_MS + 1, 2)).toBeNull();
    const a = sparkAt(7, 3, 300, 2);
    expect(a).toEqual(sparkAt(7, 3, 300, 2));
    expect(a).not.toBeNull();
    expect(sparkAt(7, 3, 100, 2)?.alpha ?? 0).toBeGreaterThan(sparkAt(7, 3, 800, 2)?.alpha ?? 1);
    expect(sparkAt(7, 3, 300, 2)).not.toEqual(sparkAt(7, 4, 300, 2));
    expect(sparkAt(8, 3, 300, 2)).not.toEqual(a);
  });
});
