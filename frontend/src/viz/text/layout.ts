/**
 * Text layout (SPEC.md §6.8): wrapping, the title-safe area and the block
 * positions. Pure functions of measured word widths, so they are tested with a
 * stub `measureText` (no canvas needed).
 *
 * Coordinates are output pixels, y down. A "block" is the wrapped text of one
 * line of lyrics: at most two rows, every row centred on the block's centre.
 */

export type TextPosition = "center" | "lower" | "upper";

/** Fraction of the frame kept free on every side (title-safe). */
export const SAFE_MARGIN = 0.05;
/** Row height as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Baseline offset from the centre of a row, in em. */
export const BASELINE_OFFSET = 0.34;
/** Gap between the main block and the "next line" block, in em. */
export const NEXT_GAP = 0.4;
export const NEXT_SIZE = 0.8;
export const NEXT_ALPHA = 0.55;
export const MAX_ROWS = 2;

export const isPortrait = (w: number, h: number): boolean => h > w;

/** Widest a row may be: 80% of the width in landscape, 88% in portrait. */
export function maxTextWidth(w: number, h: number): number {
  return w * (isPortrait(w, h) ? 0.88 : 0.8);
}

/** Distance of `lower`/`upper` text from the frame edge, as a fraction of the height. */
export function edgeInset(w: number, h: number): number {
  return isPortrait(w, h) ? 0.24 : 0.14;
}

export interface WordSpec {
  text: string;
  /** Width multiplier reserved for the word (emphasised words are drawn larger). */
  widthScale: number;
}

export interface WordBox {
  index: number;
  row: number;
  /** Centre of the word relative to the block centre, in px (already multiplied by `fit`). */
  cx: number;
  /** Reserved advance, px (scaled by `fit`). */
  w: number;
  /** Unscaled text width as measured. */
  textW: number;
}

export interface RowInfo {
  first: number;
  count: number;
  /** Row width in px (scaled by `fit`). */
  width: number;
}

export interface LineLayout {
  boxes: WordBox[];
  rows: RowInfo[];
  /** Widest row, px. */
  width: number;
  /** rows × row height, px. */
  height: number;
  /** One row's height, px. */
  rowHeight: number;
  /** ≤ 1: the factor the whole block was shrunk by to fit the width. */
  fit: number;
}

/**
 * Wraps words into one or two rows no wider than `maxWidth`. A line that needs
 * a break is split where the rows are most even; one that cannot fit in two
 * rows is shrunk uniformly (`fit`).
 */
export function layoutWords(words: readonly WordSpec[], measure: (s: string) => number, fontPx: number, maxWidth: number): LineLayout {
  const measuredSpace = measure(" ");
  const space = measuredSpace > 0.05 * fontPx ? measuredSpace : 0.28 * fontPx;
  const textW = words.map((w) => measure(w.text));
  const adv = words.map((w, i) => (textW[i] as number) * w.widthScale);
  const rowWidth = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += adv[i] as number;
    return sum + Math.max(0, to - from - 1) * space;
  };

  let split = words.length; // index where the second row starts (== length: single row)
  let fit = 1;
  const whole = rowWidth(0, words.length);
  if (whole > maxWidth && words.length > 1) {
    let best = Infinity;
    for (let k = 1; k < words.length; k++) {
      const widest = Math.max(rowWidth(0, k), rowWidth(k, words.length));
      if (widest < best) {
        best = widest;
        split = k;
      }
    }
    if (best > maxWidth) fit = maxWidth / best;
  } else if (whole > maxWidth) {
    fit = maxWidth / whole;
  }

  const ranges: Array<[number, number]> = split >= words.length ? [[0, words.length]] : [[0, split], [split, words.length]];
  const boxes: WordBox[] = [];
  const rows: RowInfo[] = [];
  let widest = 0;
  ranges.forEach(([from, to], row) => {
    const width = rowWidth(from, to);
    let x = -width / 2;
    for (let i = from; i < to; i++) {
      const w = adv[i] as number;
      boxes.push({ index: i, row, cx: (x + w / 2) * fit, w: w * fit, textW: textW[i] as number });
      x += w + space;
    }
    rows.push({ first: from, count: to - from, width: width * fit });
    widest = Math.max(widest, width * fit);
  });
  const rowHeight = LINE_HEIGHT * fontPx * fit;
  return { boxes, rows, width: widest, height: rowHeight * rows.length, rowHeight, fit };
}

/**
 * Top edge of a block of height `blockH` for a position. `below` is extra
 * height reserved under the block (the "next line"), counted for `lower` so
 * the whole stack ends at the inset. The result is clamped to the title-safe
 * area.
 */
export function placeBlock(position: TextPosition, w: number, h: number, blockH: number, below = 0): number {
  const inset = edgeInset(w, h);
  let top: number;
  switch (position) {
    case "lower":
      top = h * (1 - inset) - blockH - below;
      break;
    case "upper":
      top = h * inset;
      break;
    default:
      top = (h - blockH) / 2;
  }
  const lo = h * SAFE_MARGIN;
  const hi = h * (1 - SAFE_MARGIN) - blockH - below;
  return Math.max(lo, Math.min(hi < lo ? lo : hi, top));
}

/** Y of the baseline of row `row` in a block with top `top`, px. */
export function rowBaseline(top: number, row: number, rowHeight: number, fontPx: number, fit: number): number {
  return top + (row + 0.5) * rowHeight + BASELINE_OFFSET * fontPx * fit;
}

/** The base font size in px: `size` is a percentage of the short side. */
export function fontSizePx(sizePercent: number, w: number, h: number): number {
  return (Math.max(3, Math.min(12, sizePercent)) / 100) * Math.min(w, h);
}

/** Stacks a title card: title above, artist below, centred on the frame. Returns the block tops. */
export function titleCardTops(h: number, titleH: number, artistH: number, gap: number): { title: number; artist: number } {
  const total = titleH + gap + artistH;
  const top = (h - total) / 2;
  return { title: top, artist: top + titleH + gap };
}
