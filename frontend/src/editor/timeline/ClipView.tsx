/**
 * One clip on a track (Phase 9 SPEC §14.5, Phase 21 §B2): filmstrip / photo
 * thumb / colour swatch, waveform, name, badges, trim handles, the volume line
 * and the keyframe strip.
 */
import { memo, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Icon, Tooltip, cx } from "@/components";
import type { EditClip } from "@/lib/api";
import { parseEffects } from "@/viz/edit/schema";
import { useThumb } from "@/blocks/media/useThumbs";
import { hasFocusSwitch } from "../focus";
import { useEditorProfile } from "../profileContext";
import { clipLabel, hasSpeedChange, stripStyle, sourceWindow, type ClipStatus } from "./clipInfo";
import { GainLine } from "./GainLine";
import { KeyStrip } from "./KeyStrip";
import { Waveform } from "./Waveform";
import styles from "./TracksPanel.module.css";
import tl from "./Timeline.module.css";

export type MatteBadge = "none" | "working" | "ready";

/** A lane this tall (px, inside the clip) shows waveforms and the keyframe strip; the volume line on video clips needs a tall one. */
export const WAVE_MIN_PX = 40;
export const GAIN_VIDEO_MIN_PX = 80;

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
  /** Phase 21: the lane inside the clip, the zoom, the part in view (clip-relative px), the source's sound and the track's lock. */
  heightPx?: number;
  pps?: number;
  viewFromPx?: number;
  viewToPx?: number;
  hasAudio?: boolean;
  locked?: boolean;
  /** While a slip drag runs: the in/out readout. */
  slipText?: string | null;
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

function ClipViewImpl({
  clip,
  left,
  width,
  selected,
  status,
  pastEnd,
  sourceMs,
  fps,
  matte,
  heightPx = 48,
  pps = 80,
  viewFromPx = 0,
  viewToPx = 0,
  hasAudio = false,
  locked = false,
  slipText = null,
  onPointerDown,
  onTrimDown,
  onContextMenu,
}: ClipViewProps) {
  const effects = useMemo(() => (clip.effects ? parseEffects(clip.effects).value.length : 0), [clip.effects]);
  const label = clipLabel(clip);
  const deepTip = hasFocusSwitch(useEditorProfile()) ? "double-click to edit the video in depth, " : "double-click to put the playhead here, ";
  const showStrip = (clip.kind === "video" || clip.kind === "image") && status === "ok" && width > 24;
  const isAudio = clip.kind === "audio";
  const sounds = isAudio || (clip.kind === "video" && hasAudio);
  const showWave = sounds && heightPx >= WAVE_MIN_PX && width > 4 && status !== "missing";
  const showGain = sounds && heightPx >= (isAudio ? WAVE_MIN_PX : GAIN_VIDEO_MIN_PX) && width > 30 && status !== "missing";
  const showKeys = selected && heightPx >= WAVE_MIN_PX && width > 12;
  return (
    <div
      className={cx(styles.clip, styles[`kind_${clip.kind}`], selected && styles.selected, clip.auto && styles.auto, status === "missing" && styles.missing, status === "preparing" && styles.preparing, pastEnd && styles.pastEnd)}
      style={{ left, width: Math.max(2, width), ...(clip.kind === "color" ? { background: clip.color || "#000000" } : {}) }}
      data-clip-id={clip.id}
      data-link={clip.link || undefined}
      role="button"
      aria-label={`${label}, ${clip.kind} clip${clip.link ? ", linked" : ""}`}
      aria-pressed={selected}
      tabIndex={-1}
      data-tip={`${label}: drag to move (Alt skips snapping), click to select and seek, ${deepTip}drag an edge to trim, right-click for more${pastEnd ? ". Runs past the end of the edit" : ""}`}
      onPointerDown={(e) => onPointerDown(e, clip)}
      onContextMenu={(e) => onContextMenu(e, clip)}
    >
      {showStrip && <Strip clip={clip} sourceMs={sourceMs} fps={fps} />}
      {showWave && <Waveform clip={clip} fps={fps} pps={pps} widthPx={width} viewFromPx={viewFromPx} viewToPx={viewToPx} heightPx={heightPx} />}
      <div className={styles.clipInfo}>
        {(clip.kind === "text" || clip.kind === "visual" || isAudio) && width > 20 && <Icon name={clip.kind === "text" ? "type" : isAudio ? "music" : "sparkles"} size={12} />}
        {width > 40 && <span className={styles.clipName}>{label}</span>}
        <span className={styles.badges}>
          {clip.link && (
            <Tooltip label="Linked: these clips select, move, trim and delete together (Alt+click picks one; Ctrl+L unlinks)">
              <Icon name="link" size={11} title="Linked" />
            </Tooltip>
          )}
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
      {showGain && <GainLine clip={clip} widthPx={Math.max(2, width)} heightPx={heightPx} pps={pps} locked={locked} />}
      {showKeys && <KeyStrip clip={clip} pps={pps} locked={locked} />}
      {slipText && <div className={tl.slipReadout} role="status">{slipText}</div>}
      <div className={cx(styles.trim, styles.trimStart)} data-trim="start" data-tip="Drag to trim the start of this clip (Alt skips snapping)" onPointerDown={(e) => onTrimDown(e, clip, "start")} />
      <div className={cx(styles.trim, styles.trimEnd)} data-trim="end" data-tip="Drag to trim the end of this clip (Alt skips snapping)" onPointerDown={(e) => onTrimDown(e, clip, "end")} />
    </div>
  );
}

export const ClipView = memo(ClipViewImpl);
