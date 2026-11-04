// One-line summaries for the Sequence Editor's click-ins (Phase 10, SPEC.md §13: a launcher says what's inside).
import { formatMs } from "@/components/media";
import type { VideoClip, VideoTitle } from "@/lib/api";

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export const FIT_LABELS: Record<string, string> = { fill: "Fill the frame", "fit-blur": "Fit, blurred edges", "fit-color": "Fit, colour bars" };
export const MOTION_LABELS: Record<string, string> = { none: "Still", in: "Zoom in", out: "Zoom out", left: "Pan left", right: "Pan right" };
export const TRANSITION_LABELS: Record<string, string> = { cut: "Cut", fade: "Fade", dip: "Dip to black", slide: "Slide" };
export const STYLE_LABELS: Record<string, string> = { title: "Title", "lower-third": "Lower third", caption: "Caption", label: "Label" };
export const POSITION_LABELS: Record<string, string> = { top: "Top", center: "Centre", bottom: "Bottom" };

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "0:01.000 – 0:04.500" for a video clip, "3.0 s" for a photo. */
export function trimSummary(clip: Pick<VideoClip, "kind" | "inMs" | "outMs" | "durationMs">): string {
  return clip.kind === "video" ? `${formatMs(clip.inMs)} – ${formatMs(clip.outMs)}` : seconds(clip.durationMs);
}

/** "1× · 100%" / "2× · muted" for a video clip, the motion for a photo. */
export function playbackSummary(clip: Pick<VideoClip, "kind" | "speed" | "volume" | "motion">): string {
  if (clip.kind !== "video") return MOTION_LABELS[clip.motion || "none"] ?? "Still";
  return `${clip.speed}× · ${clip.volume === 0 ? "muted" : pct(clip.volume)}`;
}

/** "Fill the frame · Warm". */
export function pictureSummary(clip: Pick<VideoClip, "fit" | "look">): string {
  const fit = FIT_LABELS[clip.fit] ?? clip.fit;
  return clip.look && clip.look !== "none" ? `${fit} · ${cap(clip.look)}` : fit;
}

/** "Fade · 0.5 s" or "Cut". */
export function transitionSummary(clip: Pick<VideoClip, "transition">): string {
  const kind = clip.transition.kind || "cut";
  const label = TRANSITION_LABELS[kind] ?? cap(kind);
  return kind === "cut" ? label : `${label} · ${seconds(clip.transition.durationMs)}`;
}

/** The words of a title, or "Empty". */
export function titleTextSummary(title: Pick<VideoTitle, "text">): string {
  const t = title.text.replace(/\s+/g, " ").trim();
  return t || "Empty";
}

/** "Lower third · Bottom". */
export function titleStyleSummary(title: Pick<VideoTitle, "style" | "position">): string {
  return `${STYLE_LABELS[title.style] ?? title.style} · ${POSITION_LABELS[title.position] ?? title.position}`;
}

/** "0:02.000 · 3.0 s". */
export function titleTimingSummary(title: Pick<VideoTitle, "startMs" | "durationMs">): string {
  return `${formatMs(title.startMs)} · ${seconds(title.durationMs)}`;
}

/** "song.mp3 · 100%". */
export function songSummary(music: { path: string; volume: number }): string {
  const name = music.path.split(/[\\/]/).pop() ?? music.path;
  return `${name} · ${pct(music.volume)}`;
}

/** "Fades 1.0 s / 2.0 s" plus what the song does to the video. */
export function songTimingSummary(music: { offsetMs: number; fadeInMs: number; fadeOutMs: number; duck: boolean; endWithMusic: boolean }): string {
  const parts = [`Fades ${seconds(music.fadeInMs)} / ${seconds(music.fadeOutMs)}`];
  if (music.duck) parts.push("ducks");
  if (music.endWithMusic) parts.push("sets the length");
  return parts.join(" · ");
}
