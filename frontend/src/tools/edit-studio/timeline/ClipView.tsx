/** One clip on a track (Phase 9 SPEC §14.5): filmstrip / photo thumb / colour swatch, name, badges and trim handles. */
import { memo, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Icon, cx } from "@/components";
import type { EditClip } from "@/lib/api";
import { parseEffects } from "@/viz/edit/schema";
import { useThumb } from "@/tools/video-editor/useThumbs";
import { clipLabel, hasSpeedChange, stripStyle, sourceWindow, type ClipStatus } from "./clipInfo";
import styles from "./TracksPanel.module.css";

export type MatteBadge = "none" | "working" | "ready";

export interface ClipViewProps {
  clip: EditClip;
  left: number;
  width: number;
  selected: boolean;
  status: ClipStatus;
  /** Ends after the edit does. */
  pastEnd: boolean;
  /** The source's length (video filmstrip window). */
  sourceMs: number;
  fps: number;
  matte: MatteBadge;
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>, clip: EditClip): void;
  onTrimDown(e: ReactPointerEvent<HTMLElement>, clip: EditClip, edge: "start" | "end"): void;
  onContextMenu(e: ReactMouseEvent<HTMLDivElement>, clip: EditClip): void;
}

function Strip({ clip, sourceMs, fps }: { clip: EditClip; sourceMs: number; fps: number }) {
  const url = useThumb(clip.path, clip.kind);
  const style = useMemo<CSSProperties>(() => {
    if (!url) return {};
    if (clip.kind === "image") return { backgroundImage: `url("${url}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" };
    const w = sourceWindow(clip, fps);
    return { backgroundImage: `url("${url}")`, ...stripStyle(w.fromMs, w.toMs, sourceMs) };
  }, [url, clip, sourceMs, fps]);
  if (!url) return null;
  return <div className={styles.strip} style={style} aria-hidden="true" />;
}

function ClipViewImpl({ clip, left, width, selected, status, pastEnd, sourceMs, fps, matte, onPointerDown, onTrimDown, onContextMenu }: ClipViewProps) {
  const effects = useMemo(() => (clip.effects ? parseEffects(clip.effects).value.length : 0), [clip.effects]);
  const label = clipLabel(clip);
  const showStrip = (clip.kind === "video" || clip.kind === "image") && status === "ok" && width > 24;
  return (
    <div
      className={cx(styles.clip, styles[`kind_${clip.kind}`], selected && styles.selected, clip.auto && styles.auto, status === "missing" && styles.missing, status === "preparing" && styles.preparing, pastEnd && styles.pastEnd)}
      style={{ left, width: Math.max(2, width), ...(clip.kind === "color" ? { background: clip.color || "#000000" } : {}) }}
      data-clip-id={clip.id}
      role="button"
      aria-label={`${label}, ${clip.kind} clip`}
      aria-pressed={selected}
      tabIndex={-1}
      title={pastEnd ? `${label}: runs past the end of the edit` : label}
      onPointerDown={(e) => onPointerDown(e, clip)}
      onContextMenu={(e) => onContextMenu(e, clip)}
    >
      {showStrip && <Strip clip={clip} sourceMs={sourceMs} fps={fps} />}
      <div className={styles.clipInfo}>
        {width > 40 && <span className={styles.clipName}>{label}</span>}
        <span className={styles.badges}>
          {clip.pinned && <Icon name="pin" size={11} title="Pinned" />}
          {status === "missing" && <Icon name="triangle-alert" size={11} title="Missing" />}
          {status === "preparing" && <Icon name="loader" size={11} title="Preparing" />}
          {effects > 0 && (
            <span className={styles.badge} title={`${effects} effect${effects === 1 ? "" : "s"}`}>
              <Icon name="sparkles" size={11} />
              {effects}
            </span>
          )}
          {matte !== "none" && <Icon name="scan-face" size={11} title={matte === "ready" ? "Cut-out" : "Cut-out in progress"} />}
          {hasSpeedChange(clip) && <Icon name="gauge" size={11} title="Speed changes" />}
        </span>
      </div>
      <div className={cx(styles.trim, styles.trimStart)} data-trim="start" onPointerDown={(e) => onTrimDown(e, clip, "start")} />
      <div className={cx(styles.trim, styles.trimEnd)} data-trim="end" onPointerDown={(e) => onTrimDown(e, clip, "end")} />
    </div>
  );
}

export const ClipView = memo(ClipViewImpl);
