import { useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { cx, Icon, IconButton, Spinner } from "@/components";
import { formatDuration } from "@/lib/format";
import type { SlidePlayback } from "./useSlidePlayback";
import styles from "./PlayBar.module.css";

const BUSY_LABEL: Partial<Record<SlidePlayback["phase"], string>> = {
  rendering: "Making a preview of the video…",
  preparing: "Making a preview copy…",
  opening: "Opening…",
};

/** Play/pause, a seek line and the time, floating at the bottom of a playable slide. */
export function PlayBar({ pb, kind }: { pb: SlidePlayback; kind: "clip" | "video" }) {
  const ms = useSyncExternalStore(pb.subscribe, pb.position);
  const track = useRef<HTMLDivElement>(null);
  const len = pb.lengthMs;
  const busy = pb.wanted ? BUSY_LABEL[pb.phase] : undefined;
  const what = kind === "clip" ? "the clip (from In to Out, looping)" : "the video";

  const seekAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || len <= 0) return;
    pb.seek(((clientX - r.left) / r.width) * len);
  };
  // The frame under the bar pans on drag: the bar keeps its pointer events.
  const stop = (e: RPointerEvent) => e.stopPropagation();
  const onTrackDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekAt(e.clientX);
  };
  const onTrackMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) seekAt(e.clientX);
  };
  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5000 : 1000;
    if (e.key === "ArrowLeft") pb.seek(ms - step);
    else if (e.key === "ArrowRight") pb.seek(ms + step);
    else if (e.key === "Home") pb.seek(0);
    else if (e.key === "End") pb.seek(len);
    else return;
    e.preventDefault();
  };

  return (
    <div className={styles.bar} onPointerDown={stop} data-testid="slide-playbar">
      <IconButton
        size="sm"
        variant="secondary"
        icon={pb.wanted ? "pause" : "play"}
        label={pb.wanted ? "Pause" : "Play"}
        data-tip={pb.wanted ? "Pause" : `Play ${what}`}
        onClick={pb.toggle}
      />
      {busy ? (
        <span className={styles.status} role="status">
          <Spinner size={12} label={busy} />
          <span className={styles.text}>
            {busy}
            {pb.progress !== undefined && ` ${Math.round(pb.progress * 100)}%`}
          </span>
        </span>
      ) : pb.phase === "error" ? (
        <span className={cx(styles.status, styles.error)} role="alert" data-tip={pb.error?.hint || pb.error?.message}>
          <Icon name="triangle-alert" size={14} />
          <span className={styles.text}>{pb.error?.message || "This can't be played."}</span>
        </span>
      ) : (
        <>
          <div
            ref={track}
            className={styles.track}
            role="slider"
            tabIndex={len > 0 ? 0 : -1}
            aria-label="Play position"
            aria-valuemin={0}
            aria-valuemax={Math.round(len / 1000)}
            aria-valuenow={Math.round(ms / 1000)}
            aria-valuetext={formatDuration(ms / 1000)}
            aria-disabled={len <= 0 || undefined}
            data-tip={len > 0 ? "Click or drag to jump; Left and Right arrows step a second" : "Press Play first"}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onKeyDown={onTrackKey}
          >
            <span className={styles.fill} style={{ width: len > 0 ? `${Math.min(100, (ms / len) * 100)}%` : 0 }} />
          </div>
          <span className={styles.time} data-tip="Play position / length of what plays">
            {formatDuration(ms / 1000)} / {len > 0 ? formatDuration(Math.ceil(len / 1000)) : "–:––"}
          </span>
        </>
      )}
    </div>
  );
}
