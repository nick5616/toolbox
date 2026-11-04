/** One clip on a track (Phase 9 SPEC §14.5): filmstrip / photo thumb / colour swatch, name, badges and trim handles. */
import { memo, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Icon, Tooltip, cx } from "@/components";
import type { EditClip } from "@/lib/api";
import { parseEffects } from "@/viz/edit/schema";
import { useThumb } from "@/blocks/media/useThumbs";
import { hasFocusSwitch } from "../focus";
import { useEditorProfile } from "../profileContext";
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
  const deepTip = hasFocusSwitch(useEditorProfile()) ? "double-click to edit the video in depth, " : "double-click to put the playhead here, ";
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
      data-tip={`${label}: drag to move (Alt skips snapping), click to select and seek, ${deepTip}drag an edge to trim, right-click for more${pastEnd ? ". Runs past the end of the edit" : ""}`}
      onPointerDown={(e) => onPointerDown(e, clip)}
      onContextMenu={(e) => onContextMenu(e, clip)}
    >
      {showStrip && <Strip clip={clip} sourceMs={sourceMs} fps={fps} />}
      <div className={styles.clipInfo}>
        {(clip.kind === "text" || clip.kind === "visual") && width > 20 && <Icon name={clip.kind === "text" ? "type" : "sparkles"} size={12} />}
        {width > 40 && <span className={styles.clipName}>{label}</span>}
        <span className={styles.badges}>
          {clip.pinned && <Tooltip label="Pinned: Auto-fill and Cut to beat leave this clip alone"><Icon name="pin" size={11} title="Pinned" /></Tooltip>}
          {status === "missing" && <Tooltip label="The source file is missing; move it back or replace the clip"><Icon name="triangle-alert" size={11} title="Missing" /></Tooltip>}
          {status === "preparing" && <Tooltip label="Making a fast copy of this source for smooth editing; it will play when ready"><Icon name="loader" size={11} title="Preparing" /></Tooltip>}
          {effects > 0 && (
            <span className={styles.badge} data-tip={`${effects} effect${effects === 1 ? "" : "s"} on this clip; see them in the Inspector`}>
              <Icon name="sparkles" size={11} />
              {effects}
            </span>
          )}
          {matte !== "none" && <Tooltip label={matte === "ready" ? "Cut-out ready: the subject is separated from the background" : "Cut-out in progress: the subject is still being separated"}><Icon name="scan-face" size={11} title={matte === "ready" ? "Cut-out" : "Cut-out in progress"} /></Tooltip>}
          {hasSpeedChange(clip) && <Tooltip label="This clip plays faster, slower or with a speed ramp"><Icon name="gauge" size={11} title="Speed changes" /></Tooltip>}
        </span>
      </div>
      <div className={cx(styles.trim, styles.trimStart)} data-trim="start" data-tip="Drag to trim the start of this clip (Alt skips snapping)" onPointerDown={(e) => onTrimDown(e, clip, "start")} />
      <div className={cx(styles.trim, styles.trimEnd)} data-trim="end" data-tip="Drag to trim the end of this clip (Alt skips snapping)" onPointerDown={(e) => onTrimDown(e, clip, "end")} />
    </div>
  );
}

export const ClipView = memo(ClipViewImpl);
