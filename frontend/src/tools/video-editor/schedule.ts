// The sequence scheduler: which clips are on screen at timeline time t, and
// where to look in each source (SPEC.md Part B §B6.5). Pure.
import type { VideoClip, VideoMusic } from "@/lib/api";
import { speedOf, type Span } from "./timeline";

export interface Layer {
  index: number;
  /** Position in the source file (ms); photos: ms into the clip. */
  sourceMs: number;
  /** 0..1 through the clip. */
  progress: number;
  /** 0..1 */
  opacity: number;
  /** Horizontal offset as a fraction of the frame width (slide transitions). */
  offsetX: number;
  /** Audio gain from crossfading, 0..1. */
  gain: number;
  role: "main" | "incoming" | "outgoing";
}

interface Factors {
  opacity: number;
  offsetX: number;
  gain: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** How the outgoing and incoming clip look at progress p (0..1) of a join. */
export function joinFactors(kind: string, p: number): { out: Factors; in: Factors } {
  const q = clamp01(p);
  switch (kind) {
    case "fade":
      // The incoming clip fades in over a fully visible outgoing one: an exact crossfade.
      return {
        out: { opacity: 1, offsetX: 0, gain: 1 - q },
        in: { opacity: q, offsetX: 0, gain: q },
      };
    case "dip":
      return {
        out: { opacity: clamp01(1 - 2 * q), offsetX: 0, gain: 1 - q },
        in: { opacity: clamp01(2 * q - 1), offsetX: 0, gain: q },
      };
    case "slide":
      return {
        out: { opacity: 1, offsetX: -q, gain: 1 - q },
        in: { opacity: 1, offsetX: 1 - q, gain: q },
      };
    default:
      return { out: { opacity: 1, offsetX: 0, gain: 1 }, in: { opacity: 1, offsetX: 0, gain: 1 } };
  }
}

function sourceAt(c: VideoClip, s: Span, t: number): number {
  const local = Math.min(Math.max(t - s.startMs, 0), s.lenMs);
  if (c.kind === "image") return local;
  return Math.min(Math.max(c.inMs + local * speedOf(c), c.inMs), c.outMs);
}

/**
 * The layers visible at timeline time t, bottom first. At or past the end the
 * last clip is shown at its final frame. An empty timeline has no layers.
 */
export function layersAt(clips: readonly VideoClip[], spans: readonly Span[], t: number): Layer[] {
  if (clips.length === 0 || spans.length === 0) return [];
  const total = spans[spans.length - 1]?.endMs ?? 0;
  const time = Math.min(Math.max(t, 0), Math.max(total - 0.001, 0));
  const out: Layer[] = [];
  for (const s of spans) {
    const c = clips[s.index];
    if (!c || time < s.startMs || time >= s.endMs) continue;
    let f: Factors = { opacity: 1, offsetX: 0, gain: 1 };
    let role: Layer["role"] = "main";
    const prevSpan = s.index > 0 ? spans[s.index - 1] : undefined;
    const prevClip = s.index > 0 ? clips[s.index - 1] : undefined;
    if (prevSpan && prevClip && prevSpan.overlapMs > 0 && time < s.startMs + prevSpan.overlapMs) {
      f = joinFactors(prevClip.transition.kind, (time - s.startMs) / prevSpan.overlapMs).in;
      role = "incoming";
    } else if (s.overlapMs > 0 && time >= s.endMs - s.overlapMs) {
      f = joinFactors(c.transition.kind, (time - (s.endMs - s.overlapMs)) / s.overlapMs).out;
      role = "outgoing";
    }
    out.push({
      index: s.index,
      sourceMs: sourceAt(c, s, time),
      progress: s.lenMs > 0 ? clamp01((time - s.startMs) / s.lenMs) : 0,
      opacity: f.opacity,
      offsetX: f.offsetX,
      gain: f.gain,
      role,
    });
  }
  return out;
}

/** The clip a seek or split at time t refers to: the latest one that has started. */
export function clipIndexAt(spans: readonly Span[], t: number): number {
  let idx = -1;
  for (const s of spans) if (s.startMs <= t && t < s.endMs) idx = s.index;
  if (idx < 0 && spans.length > 0) return t >= (spans[spans.length - 1]?.endMs ?? 0) ? spans.length - 1 : 0;
  return idx;
}

/** Clip indexes whose sources should be ready around time t: the visible ones and the next. */
export function neededIndexes(layers: readonly Layer[], clipCount: number, t: number, spans: readonly Span[]): number[] {
  const set = new Set<number>();
  for (const l of layers) {
    set.add(l.index);
    if (l.index + 1 < clipCount) set.add(l.index + 1);
  }
  if (set.size === 0 && clipCount > 0) set.add(clipIndexAt(spans, t));
  return [...set].sort((a, b) => a - b);
}

/** Object-fit: cover framing with pan/zoom, as CSS transform fractions of the frame (mirrors the render's crop). */
export function fillTransform(
  srcAspect: number,
  frameAspect: number,
  zoom: number,
  panX: number,
  panY: number,
): { scale: number; tx: number; ty: number } {
  const fa = frameAspect > 0 ? frameAspect : 1;
  const sa = srcAspect > 0 ? srcAspect : fa;
  const z = zoom >= 1 ? zoom : 1;
  // The frame is fa wide and 1 high; the covered picture is at least as large.
  const coverW = Math.max(fa, sa);
  const coverH = Math.max(1, fa / sa);
  const overX = Math.max((coverW * z - fa) / 2, 0);
  const overY = Math.max((coverH * z - 1) / 2, 0);
  return { scale: z, tx: (overX * -panX) / fa + 0, ty: overY * -panY + 0 };
}

/** The Ken Burns transform of a photo at progress p (scale, and translate as a fraction of the frame width). */
export function photoMotion(motion: string, p: number): { scale: number; tx: number } {
  const q = clamp01(p);
  switch (motion) {
    case "in":
      return { scale: 1 + 0.25 * q, tx: 0 };
    case "out":
      return { scale: 1.25 - 0.25 * q, tx: 0 };
    case "left":
      return { scale: 1.2, tx: 0.1 - 1.2 * ((1 - 1 / 1.2) * (1 - q)) };
    case "right":
      return { scale: 1.2, tx: 0.1 - 1.2 * ((1 - 1 / 1.2) * q) };
    default:
      return { scale: 1, tx: 0 };
  }
}

/** The music's volume at timeline time t: fade in from the start, fade out to the video's end. */
export function musicGain(m: Pick<VideoMusic, "volume" | "fadeInMs" | "fadeOutMs">, t: number, totalMs: number): number {
  let g = Math.max(m.volume, 0);
  if (m.fadeInMs > 0) g *= clamp01(t / m.fadeInMs);
  if (m.fadeOutMs > 0) g *= clamp01((totalMs - t) / m.fadeOutMs);
  return g;
}

/** CSS filter approximating a look preset. */
export function lookFilter(look: string): string {
  switch (look) {
    case "vivid":
      return "saturate(1.35) contrast(1.06)";
    case "warm":
      return "sepia(0.22) saturate(1.1)";
    case "cool":
      return "hue-rotate(12deg) saturate(0.95)";
    case "mono":
      return "grayscale(1)";
    case "fade":
      return "contrast(0.86) brightness(1.08) saturate(0.8)";
    case "noir":
      return "grayscale(1) contrast(1.35) brightness(0.9)";
    default:
      return "none";
  }
}
