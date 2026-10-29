import { forwardRef, type ReactNode } from "react";
import type { MediaSource } from "@/lib/api";
import type { ContentRect, MediaPlayerHandle } from "./types";

export interface MediaPlayerProps {
  source: MediaSource;
  kind: "video" | "audio";
  /** Called with the timeline time (ms) while playing and after seeks. */
  onTime?: (ms: number) => void;
  onDuration?: (ms: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Drawn over the picture, positioned against its letterboxed rect. */
  overlay?: (rect: ContentRect) => ReactNode;
  /** Keyboard shortcuts active (default true). */
  keyboard?: boolean;
  className?: string;
}

/** Video/audio player with our own controls (SPEC.md §3.11). UI-M implements it. */
export const MediaPlayer = forwardRef<MediaPlayerHandle, MediaPlayerProps>(function MediaPlayer(_props, _ref) {
  return <div data-testid="media-player" />;
});
