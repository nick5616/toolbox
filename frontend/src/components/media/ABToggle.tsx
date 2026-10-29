import { useRef, useState } from "react";
import type { MediaSource } from "@/lib/api";
import { cx } from "../cx";
import { SegmentedControl } from "../SegmentedControl";
import { MediaPlayer } from "./MediaPlayer";
import type { MediaPlayerHandle } from "./types";
import styles from "./ABToggle.module.css";

export interface ABToggleProps {
  a: MediaSource;
  b: MediaSource;
  labels?: [string, string];
  className?: string;
  /** Optional: file paths behind a and b (cover art and waveform in the player). */
  paths?: [string, string];
  /** Called when the user switches side. */
  onSideChange?: (side: "a" | "b") => void;
}

/**
 * An audio player with an "Original | Cleaned" switch that swaps the source
 * while keeping the playhead and playing state (SPEC.md §3.11). The player
 * restores its position when the source URL changes.
 */
export function ABToggle({ a, b, labels = ["Original", "Cleaned"], className, paths, onSideChange }: ABToggleProps) {
  const [side, setSide] = useState<"a" | "b">("a");
  const player = useRef<MediaPlayerHandle>(null);
  const source = side === "a" ? a : b;
  const path = paths ? (side === "a" ? paths[0] : paths[1]) : undefined;

  return (
    <div className={cx(styles.root, className)} data-testid="ab-toggle">
      <SegmentedControl<"a" | "b">
        aria-label="Compare"
        size="sm"
        value={side}
        onChange={(v) => {
          setSide(v);
          onSideChange?.(v);
        }}
        options={[
          { value: "a", label: labels[0] },
          { value: "b", label: labels[1] },
        ]}
      />
      <MediaPlayer ref={player} source={source} kind="audio" {...(path ? { path } : {})} />
    </div>
  );
}
