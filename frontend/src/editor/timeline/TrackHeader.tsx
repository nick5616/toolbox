/**
 * A track's header column (Phase 9 SPEC §14.5, Phase 21 §B2): kind icon, name
 * (double-click renames), mute, solo, lock, a menu (move, kind, height, add
 * tracks, remove) and a bottom edge that drags the track's height S / M / L.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, IconButton, MenuButton, Tooltip, cx, type MenuItem } from "@/components";
import type { NormalTrack } from "@/viz/edit/defaults";
import { trackHeightOf, type TrackHeight } from "./ops";
import styles from "./TracksPanel.module.css";
import tl from "./Timeline.module.css";

export interface TrackHeaderProps {
  track: NormalTrack;
  index: number;
  count: number;
  selected: boolean;
  onSelect(): void;
  onRename(name: string): void;
  onMute(muted: boolean): void;
  onSolo?(solo: boolean): void;
  onLock(locked: boolean): void;
  onMove(dir: -1 | 1): void;
  onKind(kind: "video" | "adjust"): void;
  onRemove(): void;
  onHeight?(h: TrackHeight): void;
  /** Starts dragging the bottom edge (the panel resolves the drag to a height). */
  onResizeStart?(e: ReactPointerEvent<HTMLElement>): void;
  onAddTrack?(kind: "video" | "audio" | "adjust"): void;
  /** True at the 8-track limit. */
  full?: boolean;
  /** Part B: "matte" = the track below shows through this one (it isn't drawn itself); "matted" = this one shows through the track above. */
  matteRole?: "matte" | "matted" | null;
}

const KIND_TIP: Record<string, string> = {
  video: "Video track: holds footage, photos, text and visuals",
  audio: "Audio track: holds sound files and detached audio",
  adjust: "Adjustment track: its effects apply to everything beneath it",
};

export function TrackHeader(p: TrackHeaderProps) {
  const { track } = p;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const done = (save: boolean) => {
    setEditing(false);
    if (save && draft.trim() && draft.trim() !== track.name) p.onRename(draft.trim());
  };
  const height = trackHeightOf(track);
  const heightItem = (h: TrackHeight, label: string): MenuItem => ({
    id: `height-${h}`,
    label: `${label}${height === h ? " (current)" : ""}`,
    icon: "arrow-down-up",
    tip: h === "s" ? "A thin row: names and cuts only" : h === "m" ? "The usual row: thumbnails and waveforms" : "A tall row: the volume line and bigger thumbnails",
    disabled: !p.onHeight || height === h,
    onSelect: () => p.onHeight?.(h),
  });
  const addItem = (kind: "video" | "audio" | "adjust", label: string, tip: string): MenuItem => ({
    id: `add-${kind}`,
    label,
    icon: "plus",
    tip: p.full ? "An edit can have at most 8 tracks" : tip,
    disabled: !p.onAddTrack || p.full,
    onSelect: () => p.onAddTrack?.(kind),
  });
  const items = (): MenuItem[] => [
    { id: "rename", label: "Rename", icon: "pencil", tip: "Type a new name for this track (or double-click the name)", onSelect: () => (setDraft(track.name), setEditing(true)) },
    { id: "up", label: "Move up", icon: "chevron-up", tip: "Move this track above its neighbour; clips on higher tracks draw on top", disabled: p.index >= p.count - 1, onSelect: () => p.onMove(1) },
    { id: "down", label: "Move down", icon: "chevron-down", tip: "Move this track below its neighbour; clips on lower tracks draw underneath", disabled: p.index <= 0, onSelect: () => p.onMove(-1) },
    heightItem("s", "Small"),
    heightItem("m", "Medium"),
    heightItem("l", "Large"),
    addItem("video", "Add video track", "Add a video track on top"),
    addItem("audio", "Add audio track", "Add an audio track at the bottom"),
    addItem("adjust", "Add adjustment track", "Add a track whose effects apply to everything beneath it"),
    ...(track.kind === "audio"
      ? []
      : [
          {
            id: "kind",
            label: track.kind === "video" ? "Make it an adjustment track" : "Make it a video track",
            icon: "refresh-cw",
            tip: track.clips.length > 0 ? "Only empty tracks can change kind: remove or move the clips first" : track.kind === "video" ? "Adjustment tracks apply effects to everything beneath them instead of holding footage" : "Video tracks hold clips of footage, photos, text and visuals",
            disabled: track.clips.length > 0,
            onSelect: () => p.onKind(track.kind === "video" ? "adjust" : "video"),
          } satisfies MenuItem,
        ]),
    { id: "remove", label: "Remove track", icon: "trash-2", tip: p.count <= 1 ? "An edit needs at least one track" : "Delete this track and its clips from the edit (you can undo it)", disabled: p.count <= 1, onSelect: p.onRemove },
  ];

  const showIcon = track.kind !== "video" || !!p.matteRole;
  const tip =
    p.matteRole === "matte"
      ? "Matte: the track below shows through this one (not drawn itself)"
      : p.matteRole === "matted"
        ? "This track shows through the matte track above it"
        : (KIND_TIP[track.kind] ?? "Track");
  return (
    <div className={cx(styles.header, tl.rowRelative, p.selected && styles.headerSelected)} onPointerDown={p.onSelect} data-track-header={track.id} data-track-kind={track.kind}>
      {showIcon && (
        <Tooltip label={tip}>
          <Icon
            name={p.matteRole === "matte" ? "scan-line" : p.matteRole === "matted" ? "layers" : track.kind === "audio" ? "music" : track.kind === "video" ? "film" : "sliders-horizontal"}
            size={14}
            className={styles.headerIcon}
            title={p.matteRole === "matte" ? "Matte: the track below shows through this one (not drawn itself)" : p.matteRole === "matted" ? "Shows through the track above" : undefined}
          />
        </Tooltip>
      )}
      {editing ? (
        <input
          ref={input}
          className={styles.rename}
          aria-label="Track name"
          data-tip="Track name (up to 40 characters); Enter saves, Esc cancels"
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => done(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") done(true);
            if (e.key === "Escape") done(false);
          }}
        />
      ) : (
        <span className={styles.trackName} onDoubleClick={() => (setDraft(track.name), setEditing(true))} data-tip={`${track.name}: double-click to rename`}>
          {track.name}
        </span>
      )}
      <span className={tl.headerFlags}>
        <IconButton size="sm" icon={track.muted ? "volume-x" : "volume-2"} label={track.muted ? "Unmute track" : "Mute track"} data-tip={track.muted ? "Unmute: this track's clips are drawn (and heard) again" : "Mute: hide this track's clips from the preview and the export"} pressed={track.muted} onClick={() => p.onMute(!track.muted)} />
        {track.kind !== "adjust" && p.onSolo && (
          <IconButton size="sm" icon="headphones" label={track.solo ? "Unsolo track" : "Solo track"} data-tip={track.solo ? "Stop soloing: every track is heard again" : "Solo: hear only the soloed tracks"} pressed={!!track.solo} onClick={() => p.onSolo?.(!track.solo)} />
        )}
        <IconButton size="sm" icon="lock" label={track.locked ? "Unlock track" : "Lock track"} data-tip={track.locked ? "Unlock so clips on this track can be moved, trimmed and dropped on again" : "Lock to protect this track's clips from accidental moves, trims and drops"} pressed={track.locked} onClick={() => p.onLock(!track.locked)} />
        <MenuButton label={`Actions for ${track.name}`} icon="ellipsis" variant="ghost" size="sm" items={items} />
      </span>
      {p.onResizeStart && <div className={tl.headerGrow} data-grow-track={track.id} data-tip="Drag up or down to make this track shorter or taller (small, medium, large)" onPointerDown={p.onResizeStart} />}
    </div>
  );
}
