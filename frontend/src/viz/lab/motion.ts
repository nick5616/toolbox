/**
 * The motion metric (Phase 21 SPEC §C4). Pure: frames in, numbers out. VizLab's
 * motion mode feeds it presets; Color Grader's flash test reuses it.
 *
 * Frames are 64 × 36 downsamples carrying relative luminance and hue
 * (`toMotionFrame`). Nothing here reads the clock or a random source.
 */
import type { MotionFrame, MotionStats } from "./motionTypes";

export const MOTION_W = 64;
export const MOTION_H = 36;
/** WCAG 2.3.1: a change of at least this much relative luminance counts. */
export const FLASH_DELTA = 0.1;
/** ... and only where the darker of the two states is below this. */
export const FLASH_DARK_LIMIT = 0.8;
/** Saturation below this has no hue. */
export const HUE_MIN_SAT = 0.15;
/** Correlation under this between consecutive frames is a teleport. */
export const TELEPORT_CORR = 0.5;

const srgbLut = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** Linear relative luminance (WCAG) of an sRGB colour given as 0..255 values. */
function lumOf(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Downsample RGBA bytes (any size) to 64 × 36 by box-averaging a sparse grid of
 * samples per block, then convert to relative luminance (sRGB → linear) and hue.
 */
export function toMotionFrame(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, inTransition = false): MotionFrame {
  const lum = new Float32Array(MOTION_W * MOTION_H);
  const hue = new Float32Array(MOTION_W * MOTION_H);
  for (let by = 0; by < MOTION_H; by++) {
    const y0 = Math.floor((by * h) / MOTION_H);
    const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * h) / MOTION_H));
    const sy = Math.max(1, Math.floor((y1 - y0) / 4));
    for (let bx = 0; bx < MOTION_W; bx++) {
      const x0 = Math.floor((bx * w) / MOTION_W);
      const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * w) / MOTION_W));
      const sx = Math.max(1, Math.floor((x1 - x0) / 4));
      let rl = 0;
      let gl = 0;
      let bl = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y += sy) {
        for (let x = x0; x < x1 && x < w; x += sx) {
          const o = (y * w + x) * 4;
          rl += srgbLut[rgba[o] as number] as number;
          gl += srgbLut[rgba[o + 1] as number] as number;
          bl += srgbLut[rgba[o + 2] as number] as number;
          n++;
        }
      }
      const i = by * MOTION_W + bx;
      if (n === 0) {
        lum[i] = 0;
        hue[i] = NaN;
        continue;
      }
      rl /= n;
      gl /= n;
      bl /= n;
      lum[i] = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
      // Hue from the encoded (display) colour of the block average.
      const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
      hue[i] = hueOf(enc(rl), enc(gl), enc(bl));
    }
  }
  return { w: MOTION_W, h: MOTION_H, lum, hue, inTransition };
}

/** Hue in degrees from r,g,b in 0..1; NaN under the saturation floor. */
export function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx <= 0 || (mx - mn) / mx < HUE_MIN_SAT) return NaN;
  const d = mx - mn;
  let hh: number;
  if (mx === r) hh = ((g - b) / d) % 6;
  else if (mx === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  hh *= 60;
  return hh < 0 ? hh + 360 : hh;
}

/** A test/helper frame from a function of pixel index. */
export function frameFrom(lum: (i: number) => number, hue: (i: number) => number = () => NaN, inTransition = false): MotionFrame {
  const n = MOTION_W * MOTION_H;
  const l = new Float32Array(n);
  const hu = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = lum(i);
    hu[i] = hue(i);
  }
  return { w: MOTION_W, h: MOTION_H, lum: l, hue: hu, inTransition };
}

export { lumOf };

// ---- flashes ----

/**
 * Times (frame index) of the luminance swings of at least 0.10 in `series`
 * where the darker end is under 0.80. Swings alternate in direction by
 * construction (a zigzag with a 0.10 reversal threshold).
 */
export function flashTransitions(series: ArrayLike<number>): number[] {
  const out: number[] = [];
  const n = series.length;
  if (n === 0) return out;
  let anchor = series[0] as number;
  let ext = anchor;
  let extAt = 0;
  let dir = 0;
  const commit = () => {
    if (Math.min(anchor, ext) < FLASH_DARK_LIMIT) out.push(extAt);
  };
  for (let i = 1; i < n; i++) {
    const v = series[i] as number;
    if (dir === 0) {
      if (v - anchor >= FLASH_DELTA) {
        dir = 1;
        ext = v;
        extAt = i;
      } else if (anchor - v >= FLASH_DELTA) {
        dir = -1;
        ext = v;
        extAt = i;
      }
    } else if (dir === 1) {
      if (v > ext) {
        ext = v;
        extAt = i;
      } else if (ext - v >= FLASH_DELTA) {
        commit();
        anchor = ext;
        ext = v;
        extAt = i;
        dir = -1;
      }
    } else if (v < ext) {
      ext = v;
      extAt = i;
    } else if (v - ext >= FLASH_DELTA) {
      commit();
      anchor = ext;
      ext = v;
      extAt = i;
      dir = 1;
    }
  }
  if (dir !== 0) commit();
  return out;
}

/** Most flashes (pairs of opposing swings) in any window of `windowFrames` frames. */
export function maxFlashesInWindow(transitions: number[], windowFrames: number): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < transitions.length; i++) {
    const t0 = transitions[i] as number;
    if (j < i) j = i;
    while (j < transitions.length && (transitions[j] as number) < t0 + windowFrames) j++;
    best = Math.max(best, Math.floor((j - i) / 2));
  }
  return best;
}

const CELL_COLS = 4;
const CELL_ROWS = 4;

function flashMax(frames: MotionFrame[], fps: number): number {
  const n = frames.length;
  if (n < 2) return 0;
  const win = Math.max(1, Math.round(fps));
  const w = (frames[0] as MotionFrame).w;
  const h = (frames[0] as MotionFrame).h;
  const series: Float32Array[] = [];
  for (let c = 0; c <= CELL_COLS * CELL_ROWS; c++) series.push(new Float32Array(n));
  for (let f = 0; f < n; f++) {
    const lum = (frames[f] as MotionFrame).lum;
    const sums = new Float64Array(CELL_COLS * CELL_ROWS);
    const counts = new Float64Array(CELL_COLS * CELL_ROWS);
    let total = 0;
    for (let y = 0; y < h; y++) {
      const cy = Math.min(CELL_ROWS - 1, Math.floor((y * CELL_ROWS) / h));
      for (let x = 0; x < w; x++) {
        const cx = Math.min(CELL_COLS - 1, Math.floor((x * CELL_COLS) / w));
        const v = lum[y * w + x] as number;
        sums[cy * CELL_COLS + cx] = (sums[cy * CELL_COLS + cx] as number) + v;
        counts[cy * CELL_COLS + cx] = (counts[cy * CELL_COLS + cx] as number) + 1;
        total += v;
      }
    }
    for (let c = 0; c < CELL_COLS * CELL_ROWS; c++) (series[c] as Float32Array)[f] = (sums[c] as number) / Math.max(1, counts[c] as number);
    (series[CELL_COLS * CELL_ROWS] as Float32Array)[f] = total / (w * h);
  }
  let best = 0;
  for (const s of series) best = Math.max(best, maxFlashesInWindow(flashTransitions(s), win));
  return best;
}

// ---- the rest ----

const HIST_BINS = 2000;

/** Pearson correlation of two luminance planes; flat planes compare by their mean. */
function correlation(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const eps = 1e-9 * n;
  if (saa < eps && sbb < eps) return Math.abs(ma - mb) < 0.05 ? 1 : 0;
  if (saa < eps || sbb < eps) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/** Pixels darker than this (relative luminance) carry no hue vote: near-black tints flicker without being seen. */
const HUE_MIN_LUM = 0.004;

/**
 * Dominant hue of a frame: the peak 10° bin's circular mean (with its neighbours); NaN when no pixel has a hue.
 * With `lum`, each pixel votes with its luminance, so the colour the eye sees wins over a dim tinted background
 * (Phase 21: dim near-grey frames used to flip the dominant hue between unrelated bins).
 */
export function dominantHue(hue: Float32Array, lum?: Float32Array): number {
  const bins = new Float64Array(36);
  const weight = (i: number): number => (lum ? ((lum[i] as number) >= HUE_MIN_LUM ? (lum[i] as number) : 0) : 1);
  let any = false;
  for (let i = 0; i < hue.length; i++) {
    const h = hue[i] as number;
    const w = weight(i);
    if (Number.isNaN(h) || w <= 0) continue;
    any = true;
    const k = Math.min(35, Math.floor(h / 10));
    bins[k] = (bins[k] as number) + w;
  }
  if (!any) return NaN;
  // smooth over the neighbouring bins so a tie between two adjacent bins doesn't flip the peak
  let peak = 0;
  let best = -1;
  for (let k = 0; k < 36; k++) {
    const v = (bins[(k + 35) % 36] as number) + (bins[k] as number) + (bins[(k + 1) % 36] as number);
    if (v > best) {
      best = v;
      peak = k;
    }
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < hue.length; i++) {
    const h = hue[i] as number;
    const w = weight(i);
    if (Number.isNaN(h) || w <= 0) continue;
    const k = Math.min(35, Math.floor(h / 10));
    const d = Math.min((k - peak + 36) % 36, (peak - k + 36) % 36);
    if (d > 1) continue;
    sx += w * Math.cos((h * Math.PI) / 180);
    sy += w * Math.sin((h * Math.PI) / 180);
  }
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const BLOCK = 4;
/** A block that changed by this much on average counts as fully "busy". */
const BUSY_FULL = 0.1;

export const EMPTY_STATS: MotionStats = { flashMaxPerSec: 0, meanDelta: 0, p95Delta: 0, teleports: 0, hueChurn: 0, busyness: 0 };

/** All the motion numbers for a run of frames at `fps`. */
export function measureMotion(frames: MotionFrame[], fps: number): MotionStats {
  if (frames.length < 2) return { ...EMPTY_STATS };
  const first = frames[0] as MotionFrame;
  const { w, h } = first;
  const n = w * h;
  const hist = new Float64Array(HIST_BINS);
  let sumDelta = 0;
  let pairs = 0;
  let teleports = 0;
  let busySum = 0;
  let blocks = 0;
  let hueSum = 0;
  let huePairs = 0;
  let prevHue = dominantHue(first.hue, first.lum);
  const bw = Math.floor(w / BLOCK);
  const bh = Math.floor(h / BLOCK);
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1] as MotionFrame;
    const b = frames[f] as MotionFrame;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs((b.lum[i] as number) - (a.lum[i] as number));
      s += d;
      const k = Math.min(HIST_BINS - 1, Math.floor(d * HIST_BINS));
      hist[k] = (hist[k] as number) + 1;
    }
    sumDelta += s / n;
    pairs++;
    if (!b.inTransition && correlation(a.lum, b.lum) < TELEPORT_CORR) teleports++;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let sad = 0;
        for (let y = 0; y < BLOCK; y++) {
          const row = (by * BLOCK + y) * w + bx * BLOCK;
          for (let x = 0; x < BLOCK; x++) sad += Math.abs((b.lum[row + x] as number) - (a.lum[row + x] as number));
        }
        busySum += Math.min(1, sad / (BLOCK * BLOCK) / BUSY_FULL);
        blocks++;
      }
    }
    const hb = dominantHue(b.hue, b.lum);
    if (!Number.isNaN(hb) && !Number.isNaN(prevHue)) {
      const d = Math.abs(hb - prevHue);
      hueSum += Math.min(d, 360 - d);
      huePairs++;
    }
    prevHue = hb;
  }
  // p95 from the histogram (bin upper edge, so exact zero stays near zero).
  const total = pairs * n;
  let acc = 0;
  let p95 = 0;
  for (let k = 0; k < HIST_BINS; k++) {
    acc += hist[k] as number;
    if (acc >= total * 0.95) {
      p95 = k / HIST_BINS;
      break;
    }
  }
  return {
    flashMaxPerSec: flashMax(frames, fps),
    meanDelta: sumDelta / pairs,
    p95Delta: p95,
    teleports,
    hueChurn: huePairs > 0 ? (hueSum / huePairs) * fps : 0,
    busyness: blocks > 0 ? busySum / blocks : 0,
  };
}
