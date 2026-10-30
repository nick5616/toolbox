/**
 * Text animation timing (SPEC.md §6.8). Pure functions of time: which line is
 * on screen and how opaque, what each word does per preset, the emphasis
 * envelope and the spark particles. Nothing here is random or reads a clock.
 */
import type { TextPreset } from "../types";

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (x: number): number => 1 - (1 - clamp01(x)) ** 3;
/** Ease-out with overshoot (peaks ≈ 1.1 around x = 0.6, ends at 1). */
export function easeOutBack(x: number, overshoot = 1.70158): number {
  const t = clamp01(x) - 1;
  return 1 + (overshoot + 1) * t * t * t + overshoot * t * t;
}

export const isSubtitle = (p: TextPreset): boolean => p === "subtitle" || p === "subtitle-boxed";

// ---- lines -----------------------------------------------------------------

export interface LineLike {
  startMs: number;
  endMs: number;
}

/** Lines closer together than this are shown back to back without fading between them. */
export const CONTIGUOUS_GAP_MS = 700;
/** The next line is shown (showNext) when it starts within this long. */
export const NEXT_LOOKAHEAD_MS = 6000;
/** Longest the title card is shown, ms. */
export const TITLE_CARD_MS = 3000;
export const POP_MS = 120;

export interface Fades {
  inMs: number;
  outMs: number;
}
export function fadesFor(preset: TextPreset): Fades {
  switch (preset) {
    case "pop":
      return { inMs: 120, outMs: 280 };
    case "rise":
      return { inMs: 380, outMs: 380 };
    case "typewriter":
      return { inMs: 60, outMs: 300 };
    case "fade":
      return { inMs: 450, outMs: 450 };
    case "subtitle":
    case "subtitle-boxed":
      return { inMs: 90, outMs: 120 };
    default:
      return { inMs: 180, outMs: 320 };
  }
}

export interface LineTiming {
  /** The line starts to show here. */
  showFromMs: number;
  fadeInMs: number;
  /** Fully visible until here, then fades. */
  holdUntilMs: number;
  fadeOutMs: number;
}

const contiguousLead = (gap: number): number => Math.max(0, Math.min(120, gap / 2));

export function lineTiming(lines: readonly LineLike[], i: number, fades: Fades): LineTiming {
  const l = lines[i] as LineLike;
  const prev = lines[i - 1];
  const next = lines[i + 1];
  const gapPrev = prev ? l.startMs - prev.endMs : Infinity;
  const contigPrev = gapPrev < CONTIGUOUS_GAP_MS;
  const showFromMs = l.startMs - (contigPrev ? contiguousLead(gapPrev) : fades.inMs);
  let holdUntilMs = l.endMs;
  let fadeOutMs = fades.outMs;
  if (next) {
    const gapNext = next.startMs - l.endMs;
    if (gapNext < CONTIGUOUS_GAP_MS) {
      holdUntilMs = next.startMs - contiguousLead(gapNext);
      fadeOutMs = 0;
    }
  }
  return { showFromMs, fadeInMs: contigPrev ? 0 : fades.inMs, holdUntilMs: Math.max(holdUntilMs, showFromMs), fadeOutMs };
}

/** Opacity of a line at tMs from its timing (0 outside). */
export function lineAlpha(tMs: number, tm: LineTiming): number {
  if (tMs < tm.showFromMs) return 0;
  if (tMs >= tm.holdUntilMs + tm.fadeOutMs) return 0;
  let a = tm.fadeInMs > 0 ? smoothstep((tMs - tm.showFromMs) / tm.fadeInMs) : 1;
  if (tMs > tm.holdUntilMs) a *= 1 - smoothstep((tMs - tm.holdUntilMs) / tm.fadeOutMs);
  return a;
}

export interface Selection {
  main: { index: number; alpha: number; timing: LineTiming } | null;
  next: { index: number; alpha: number } | null;
}

/** The line to show at tMs (and the upcoming one when `showNext`). */
export function selectLines(lines: readonly LineLike[], tMs: number, preset: TextPreset, showNext: boolean): Selection {
  const none: Selection = { main: null, next: null };
  if (lines.length === 0) return none;
  const fades = fadesFor(preset);
  // last line whose start is not after tMs + the longest lead
  let lo = 0;
  let hi = lines.length - 1;
  let j = -1;
  const horizon = tMs + Math.max(fades.inMs, 120);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid] as LineLike).startMs <= horizon) {
      j = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let k = j; k >= 0 && k >= j - 1; k--) {
    const tm = lineTiming(lines, k, fades);
    if (tm.showFromMs > tMs) continue;
    const alpha = lineAlpha(tMs, tm);
    if (alpha <= 0) return none;
    const nx = lines[k + 1];
    const wantNext = showNext && !isSubtitle(preset) && nx && nx.startMs - tMs < NEXT_LOOKAHEAD_MS;
    return { main: { index: k, alpha, timing: tm }, next: wantNext ? { index: k + 1, alpha } : null };
  }
  return none;
}

/**
 * How far the line has been "promoted" from the next-line slot to the main
 * slot (0..1 over 220 ms), so the slot change animates instead of jumping.
 */
export function promotion(tMs: number, timing: LineTiming): number {
  return smoothstep((tMs - timing.showFromMs) / 220);
}

/** `rise`: the vertical offset of the line as a fraction of the frame height (positive = lower). */
export function riseOffset(tMs: number, timing: LineTiming): number {
  const SLIDE = 380;
  const inPart = (1 - easeOutCubic((tMs - timing.showFromMs) / SLIDE)) * 0.03;
  const outPart = smoothstep((tMs - timing.holdUntilMs) / SLIDE) * 0.012;
  return inPart - outPart;
}

/** Title card opacity: shown up to 3 s before the first line, with 400 ms fades; 0 when there is no room. */
export function titleCardAlpha(tMs: number, firstLineStartMs: number): number {
  const end = firstLineStartMs - 250;
  const start = Math.max(0, end - TITLE_CARD_MS);
  if (end - start < 900 || tMs < start || tMs >= end) return 0;
  const fade = 400;
  return smoothstep((tMs - start) / fade) * (1 - smoothstep((tMs - (end - fade)) / fade));
}

// ---- words -----------------------------------------------------------------

export interface WordTiming {
  startMs: number;
  endMs: number;
  /** Position in the line. */
  index: number;
  /** Number of characters (typewriter). */
  chars: number;
}

export interface WordAnim {
  alpha: number;
  /** Relative scale about the word's baseline-centre. */
  scale: number;
  /** Offset in em (positive = down). */
  dy: number;
  /** Karaoke fill progress 0..1, or -1 when the preset has none. */
  progress: number;
  /** Typewriter: characters shown (fractional), or -1 when not typed. */
  typed: number;
  /** 0..1: how much the fill is pulled to the highlight colour (non-karaoke). */
  flash: number;
}

const seconds = (ms: number): number => ms / 1000;

/** Pop: scale 0.55 → overshoot → 1 over 120 ms (0 before the word starts). */
export function popScale(ageMs: number): number {
  if (ageMs < 0) return 0.55;
  if (ageMs >= POP_MS) return 1;
  return 0.55 + 0.45 * easeOutBack(ageMs / POP_MS);
}

export const karaokeProgress = (tMs: number, w: { startMs: number; endMs: number }): number => clamp01((tMs - w.startMs) / Math.max(1, w.endMs - w.startMs));

/** Characters revealed by a typewriter between the word's start and end. */
export const typedChars = (tMs: number, w: { startMs: number; endMs: number }, chars: number): number => chars * clamp01((tMs - w.startMs) / Math.max(1, w.endMs - w.startMs));

/** Reveal position (px) for `typed` characters given the prefix widths (`prefix[n]` = width of the first n chars). */
export function typewriterReveal(prefix: ArrayLike<number>, typed: number): number {
  const n = prefix.length - 1;
  if (n <= 0) return 0;
  const k = Math.min(n, Math.floor(typed));
  if (k >= n) return prefix[n] as number;
  const a = prefix[k] as number;
  const b = prefix[k + 1] as number;
  return a + (b - a) * smoothstep(typed - k);
}

/** Wave: the window in which a word bobs (0..1), soft at both ends. */
export function waveEnvelope(tMs: number, w: { startMs: number; endMs: number }): number {
  return smoothstep((tMs - (w.startMs - 80)) / 160) * (1 - smoothstep((tMs - w.endMs) / 220));
}

/** Wave offset in em for a word. */
export function waveOffset(tMs: number, w: WordTiming): number {
  const env = waveEnvelope(tMs, w);
  return -0.2 * env * Math.sin(2 * Math.PI * (2.2 * seconds(tMs) - 0.18 * w.index));
}

export function wordAnim(preset: TextPreset, tMs: number, w: WordTiming): WordAnim {
  const base: WordAnim = { alpha: 1, scale: 1, dy: 0, progress: -1, typed: -1, flash: 0 };
  const age = tMs - w.startMs;
  switch (preset) {
    case "karaoke": {
      const punch = age >= 0 ? Math.exp(-age / 160) : 0;
      return { ...base, progress: karaokeProgress(tMs, w), scale: 1 + 0.06 * punch };
    }
    case "pop": {
      if (age < 0) return { ...base, alpha: 0, scale: 0.55 };
      return { ...base, alpha: smoothstep(age / (POP_MS * 0.6)), scale: popScale(age), flash: 1 - smoothstep(age / 380) };
    }
    case "typewriter":
      return { ...base, typed: typedChars(tMs, w, w.chars) };
    case "wave": {
      const env = waveEnvelope(tMs, w);
      return { ...base, dy: waveOffset(tMs, w), scale: 1 + 0.05 * env, flash: env };
    }
    default:
      return base; // rise, fade, subtitle: the line-level fade/slide does the work
  }
}

/** Emphasis envelope: 0 before the word, a burst at its start that settles to 0.35. */
export function emphasisEnv(tMs: number, startMs: number): number {
  const age = tMs - startMs;
  return age < 0 ? 0 : 0.35 + 0.65 * Math.exp(-age / 450);
}

// ---- sparks ----------------------------------------------------------------

export const SPARKS_PER_WORD = 12;
export const SPARK_LIFE_MS = 900;

function hash32(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface Spark {
  /** Offset from the word centre in em (y down). */
  dx: number;
  dy: number;
  /** Radius in em. */
  size: number;
  /** 0..1 */
  alpha: number;
}

/**
 * Spark `k` of the burst that belongs to word `wordSeed` at `ageMs` since the
 * word started; null when it has faded. Closed-form, damped velocity.
 */
export function sparkAt(wordSeed: number, k: number, ageMs: number, wordWidthEm: number): Spark | null {
  if (ageMs < 0 || ageMs > SPARK_LIFE_MS) return null;
  const r1 = hash32(wordSeed, k, 1);
  const r2 = hash32(wordSeed, k, 2);
  const r3 = hash32(wordSeed, k, 3);
  const r4 = hash32(wordSeed, k, 4);
  const angle = (-0.5 + (r1 - 0.5) * 1.7) * Math.PI; // fan upwards
  const speed = 0.7 + r2 * 1.5; // em / s
  const tau = 0.4;
  const age = seconds(ageMs);
  const travel = speed * tau * (1 - Math.exp(-age / tau));
  const life = ageMs / SPARK_LIFE_MS;
  return {
    dx: (r4 - 0.5) * wordWidthEm + Math.cos(angle) * travel,
    dy: -0.25 + Math.sin(angle) * travel + 0.5 * 0.9 * age * age,
    size: (0.025 + r3 * 0.05) * (1 - life * 0.7),
    alpha: (1 - life) ** 1.5,
  };
}

/** A stable integer seed for a word of a line. */
export const wordSeed = (lineIndex: number, wordIndex: number): number => lineIndex * 977 + wordIndex * 31 + 7;
