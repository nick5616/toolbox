/**
 * Preview quality tiers (Phase 21 SPEC B5): Draft plays the preview-tier edit
 * streams (<= 540 px short side, the default), Full plays the export-tier
 * streams (for checking keys and text). The frame keys are identical in both
 * tiers (`v:<path>`), so switching is `provider.setFiles(...)` with the other
 * URLs: streams whose URL changed drop their decoded frames, the rest stay.
 */
import type { EditFiles } from "../edit/types";
import type { StreamRef } from "./types";

export type PreviewTier = "draft" | "full";

/** A source's two edit streams (the shape of the Go EditStream pair, reduced to what's needed). */
export interface TierStreams<T> {
  preview: T | null;
  export: T | null;
}

/** The stream to play for a tier; Full falls back to the preview stream while the export tier isn't made. */
export function streamForTier<T>(src: TierStreams<T> | null | undefined, tier: PreviewTier): T | null {
  if (!src) return null;
  if (tier === "full") return src.export ?? src.preview;
  return src.preview;
}

/**
 * The files the provider should read for a tier: Full uses `full` when the
 * host has export-tier files, and falls back to the Draft files stream by
 * stream (a clip without an export stream still plays).
 */
export function filesForQuality(draft: EditFiles, full: EditFiles | null | undefined, tier: PreviewTier): EditFiles {
  if (tier !== "full" || !full) return draft;
  const streams: Record<string, StreamRef> = { ...draft.streams };
  for (const [k, v] of Object.entries(full.streams)) streams[k] = v;
  return { streams, images: draft.images };
}
