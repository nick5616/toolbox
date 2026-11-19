/**
 * The ruler's ticks (Phase 21 SPEC §B2): labelled major ticks and unlabelled
 * minor ones that adapt to the zoom: frames, then seconds, then minutes.
 * Pure; the ruler component draws what this returns.
 */

export interface Tick {
  ms: number;
  major: boolean;
  /** Only on major ticks. */
  label?: string;
}

/** Least pixels between two labelled ticks. */
export const MIN_LABEL_PX = 84;
/** Least pixels between two minor ticks. */
export const MIN_MINOR_PX = 7;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Candidate spacings of the labelled ticks, in ms, for a frame rate. */
export function majorSteps(fps: number): number[] {
  const f = 1000 / Math.max(1, fps);
  return [f, 2 * f, 5 * f, 10 * f, SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 6 * HOUR].filter((s, i, a) => i === 0 || s > (a[i - 1] as number));
}

/** The smallest labelled spacing that keeps labels at least MIN_LABEL_PX apart. */
export function majorStepFor(pps: number, fps: number): number {
  const steps = majorSteps(fps);
  return steps.find((s) => (s * pps) / 1000 >= MIN_LABEL_PX) ?? (steps[steps.length - 1] as number);
}

/** How many minor ticks fit in one major step (1 = none). */
export function subdivisionsFor(stepMs: number, pps: number, fps: number): number {
  const f = 1000 / Math.max(1, fps);
  for (const d of [10, 5, 4, 2]) {
    const minor = stepMs / d;
    // Frame steps divide into whole frames only.
    if (stepMs < SEC && minor < f - 0.001) continue;
    if ((minor * pps) / 1000 >= MIN_MINOR_PX) return d;
  }
  return 1;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A label for a tick: SS:FF below a second of spacing, M:SS to a minute, H:MM:SS above. */
export function rulerLabel(ms: number, stepMs: number, fps: number): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / HOUR);
  const m = Math.floor((total % HOUR) / MIN);
  const s = Math.floor((total % MIN) / SEC);
  if (stepMs < SEC) {
    const frames = Math.round(((total % SEC) / 1000) * fps);
    const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : m > 0 ? `${m}:${pad(s)}` : `${s}`;
    return `${base}:${pad(frames)}`;
  }
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** Ticks inside the window [scrollMs, scrollMs + widthPx / pps). */
export function rulerTicks(pps: number, scrollMs: number, widthPx: number, fps: number): Tick[] {
  if (!(pps > 0) || widthPx <= 0) return [];
  const step = majorStepFor(pps, fps);
  const d = subdivisionsFor(step, pps, fps);
  const minor = step / d;
  const endMs = scrollMs + (widthPx * 1000) / pps;
  const first = Math.floor(scrollMs / minor);
  const last = Math.ceil(endMs / minor);
  const out: Tick[] = [];
  for (let i = Math.max(0, first); i <= last; i++) {
    const ms = i * minor;
    const major = i % d === 0;
    out.push(major ? { ms, major, label: rulerLabel(ms, step, fps) } : { ms, major });
  }
  return out;
}
