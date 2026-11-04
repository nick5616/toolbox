/** Writes velocity ramps into clips (one clip, the selection, or a section's new clips). */
import type { EditClip, EditSourceState } from "@/lib/api";
import { serializeSpeed } from "@/viz/edit/schema";
import type { Marker } from "@/viz/edit/types";
import { hitTimes, velocityRamp, type VelocitySettings } from "./velocityRamp";

/** The footage left after a video clip's in point (Infinity when unknown). */
export function sourceRoom(clip: Pick<EditClip, "inMs" | "path">, sources: Record<string, EditSourceState | undefined>): number {
  const d = sources[clip.path]?.info.durationMs ?? 0;
  return d > 0 ? Math.max(0, d - clip.inMs) : Number.POSITIVE_INFINITY;
}

/** The clip with a velocity ramp (or unchanged: not a video, or too short). `null` settings = back to normal speed. */
export function withVelocity(clip: EditClip, s: VelocitySettings | null, markers: readonly Marker[], sources: Record<string, EditSourceState | undefined>): EditClip {
  if (clip.kind !== "video") return clip;
  if (!s) return { ...clip, speed: "" };
  const hits = hitTimes(markers, s.hits, clip.startMs, clip.endMs);
  const p = velocityRamp(s, clip.endMs - clip.startMs, hits, sourceRoom(clip, sources));
  return p ? { ...clip, speed: serializeSpeed(p), slow: clip.slow || "blend" } : clip;
}
