import { describe, expect, it } from "vitest";
import { edgeInset, fontSizePx, layoutWords, maxTextWidth, placeBlock, rowBaseline, titleCardTops, SAFE_MARGIN, type WordSpec } from "./layout";

/** 10 px per character, 10 px for a space. */
const measure = (s: string): number => s.length * 10;
const words = (s: string, scale = 1): WordSpec[] => s.split(" ").map((text) => ({ text, widthScale: scale }));

describe("maxTextWidth / edgeInset", () => {
  it("wraps at 80% in landscape and 88% in portrait", () => {
    expect(maxTextWidth(1920, 1080)).toBeCloseTo(1536);
    expect(maxTextWidth(1080, 1920)).toBeCloseTo(950.4);
  });
  it("insets lower text by 14% (24% in portrait)", () => {
    expect(edgeInset(1920, 1080)).toBe(0.14);
    expect(edgeInset(1080, 1920)).toBe(0.24);
  });
  it("sizes fonts as a percentage of the short side, clamped to 3..12", () => {
    expect(fontSizePx(6, 1920, 1080)).toBeCloseTo(64.8);
    expect(fontSizePx(6, 1080, 1920)).toBeCloseTo(64.8);
    expect(fontSizePx(40, 1000, 1000)).toBeCloseTo(120);
    expect(fontSizePx(0, 1000, 1000)).toBeCloseTo(30);
  });
});

describe("layoutWords", () => {
  it("keeps a short line on one row, centred", () => {
    const l = layoutWords(words("hello big world"), measure, 50, 1000);
    expect(l.rows).toHaveLength(1);
    expect(l.fit).toBe(1);
    // 50 + 30 + 50 + two 10 px spaces
    expect(l.width).toBeCloseTo(50 + 30 + 50 + 20);
    const sum = l.boxes.reduce((a, b) => a + b.cx, 0);
    expect(l.boxes[0]?.cx).toBeLessThan(0);
    expect(l.boxes[2]?.cx).toBeGreaterThan(0);
    expect(Math.abs(sum)).toBeLessThan(40);
    expect(l.height).toBeCloseTo(l.rowHeight);
  });

  it("wraps into two balanced rows and never more", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh";
    const l = layoutWords(words(text), measure, 50, 220);
    expect(l.rows).toHaveLength(2);
    expect(l.rows.map((r) => r.count)).toEqual([4, 4]);
    expect(l.width).toBeLessThanOrEqual(220);
    expect(l.fit).toBe(1);
    expect(l.boxes.filter((b) => b.row === 1)).toHaveLength(4);
  });

  it("shrinks uniformly when two rows are still too wide", () => {
    const l = layoutWords(words("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd"), measure, 50, 150);
    expect(l.rows).toHaveLength(2);
    expect(l.fit).toBeLessThan(1);
    expect(l.width).toBeLessThanOrEqual(150 + 1e-6);
    expect(l.rowHeight).toBeCloseTo(1.2 * 50 * l.fit);
  });

  it("shrinks a single over-wide word", () => {
    const l = layoutWords(words("supercalifragilistic"), measure, 50, 100);
    expect(l.rows).toHaveLength(1);
    expect(l.width).toBeCloseTo(100);
    expect(l.fit).toBeCloseTo(0.5);
  });

  it("reserves extra width for emphasised words", () => {
    const plain = layoutWords(words("one two"), measure, 50, 1000);
    const wide = layoutWords([{ text: "one", widthScale: 1 }, { text: "two", widthScale: 1.5 }], measure, 50, 1000);
    expect(wide.width).toBeCloseTo(plain.width + 15);
    expect(wide.boxes[1]?.w).toBeCloseTo(45);
  });

  it("handles an empty line", () => {
    const l = layoutWords([], measure, 50, 1000);
    expect(l.boxes).toHaveLength(0);
  });
});

describe("placeBlock (safe areas and positions)", () => {
  const cases: Array<[string, number, number]> = [
    ["16:9", 1920, 1080],
    ["9:16", 1080, 1920],
  ];
  for (const [name, w, h] of cases) {
    it(`${name}: lower text ends at the inset, centre is centred, upper starts at the inset`, () => {
      const blockH = 0.1 * h;
      const inset = edgeInset(w, h);
      expect(placeBlock("lower", w, h, blockH) + blockH).toBeCloseTo(h * (1 - inset));
      expect(placeBlock("center", w, h, blockH)).toBeCloseTo((h - blockH) / 2);
      expect(placeBlock("upper", w, h, blockH)).toBeCloseTo(h * inset);
    });
    it(`${name}: a stack with a next line ends at the inset`, () => {
      const top = placeBlock("lower", w, h, 100, 60);
      expect(top + 160).toBeCloseTo(h * (1 - edgeInset(w, h)));
    });
    it(`${name}: oversized blocks stay in the title-safe area`, () => {
      for (const pos of ["lower", "center", "upper"] as const) {
        const blockH = h * 0.5;
        const top = placeBlock(pos, w, h, blockH);
        expect(top).toBeGreaterThanOrEqual(h * SAFE_MARGIN - 1e-6);
        expect(top + blockH).toBeLessThanOrEqual(h * (1 - SAFE_MARGIN) + 1e-6);
      }
    });
    it(`${name}: wrapped rows never leave the horizontal safe area`, () => {
      const l = layoutWords(words("a quite long line of lyrics that needs wrapping around the screen yes"), measure, 0.07 * Math.min(w, h), maxTextWidth(w, h));
      expect(l.width / 2).toBeLessThanOrEqual(w / 2 - w * SAFE_MARGIN);
    });
  }
  it("puts rows on baselines inside the block", () => {
    const b0 = rowBaseline(100, 0, 60, 50, 1);
    const b1 = rowBaseline(100, 1, 60, 50, 1);
    expect(b1 - b0).toBeCloseTo(60);
    expect(b0).toBeGreaterThan(100);
    expect(b0).toBeLessThan(160);
  });
  it("stacks the title card around the centre", () => {
    const t = titleCardTops(1000, 100, 50, 30);
    expect(t.title).toBeCloseTo((1000 - 180) / 2);
    expect(t.artist).toBeCloseTo(t.title + 130);
  });
});
