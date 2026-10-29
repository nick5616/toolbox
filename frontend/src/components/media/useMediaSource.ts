import type { MediaSource } from "@/lib/api";
import type { AppErrorShape } from "@/lib/errors";

export type MediaSourceStatus = "idle" | "loading" | "preparing" | "ready" | "error";

export interface MediaSourceState {
  status: MediaSourceStatus;
  source?: MediaSource;
  /** 0..1 while a preview copy is being made. */
  progress?: number;
  error?: AppErrorShape;
  retry(): void;
}

/**
 * Opens a local file for playback through MediaService.Open, follows the
 * preview-copy job when the webview can't play it, then re-opens
 * (SPEC.md §3.11). UI-M implements it.
 */
export function useMediaSource(path: string | null): MediaSourceState {
  return { status: path ? "loading" : "idle", retry: () => undefined };
}
