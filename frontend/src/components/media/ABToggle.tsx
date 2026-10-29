import type { MediaSource } from "@/lib/api";

export interface ABToggleProps {
  a: MediaSource;
  b: MediaSource;
  labels?: [string, string];
  className?: string;
}

/**
 * An audio player with an "Original | Cleaned" switch that swaps the source
 * while keeping the playhead and playing state (SPEC.md §3.11). UI-M implements it.
 */
export function ABToggle(_props: ABToggleProps) {
  return <div data-testid="ab-toggle" />;
}
