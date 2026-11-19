/**
 * A handle to the running engine's `samplePre` (Phase 21 SPEC §B4/§E5), so the
 * editor's eyedropper can read a clip's own pre-effect pixel without importing
 * the engine or the canvas. `EditCanvas` registers it while an engine exists
 * and clears it on teardown; nothing else sets it.
 *
 * `samplePre(clipId, u, v)`: u, v are the clip's source picture 0..1 (origin
 * top-left, flip already applied); it returns the 5 × 5 average of the source
 * pixel in straight sRGB 0..1, or null when the clip has no frame yet.
 */
export type PreSampler = (clipId: string, u: number, v: number) => [number, number, number] | null;

let current: PreSampler | null = null;

export function setPreSampler(fn: PreSampler | null): void {
  current = fn;
}

/** Samples through the registered engine; null when none is registered. */
export function samplePre(clipId: string, u: number, v: number): [number, number, number] | null {
  return current ? current(clipId, u, v) : null;
}

export function hasPreSampler(): boolean {
  return current !== null;
}

/** #rrggbb from straight sRGB 0..1. */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
