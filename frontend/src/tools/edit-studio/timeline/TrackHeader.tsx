/** A track's header column (Phase 9 SPEC §14.5): kind icon, name (double-click renames), mute, lock, menu. */
import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, MenuButton, Tooltip, cx, type MenuItem } from "@/components";
import type { NormalTrack } from "@/viz/edit/defaults";
import styles from "./TracksPanel.module.css";

export interface TrackHeaderProps {
  track: NormalTrack;
  index: number;
  count: number;
  selected: boolean;
  onSelect(): void;
  onRename(name: string): void;
  onMute(muted: boolean): void;
  onLock(locked: boolean): void;
  onMove(dir: -1 | 1): void;
  onKind(kind: "video" | "adjust"): void;
  onRemove(): void;
  /** Part B: "matte" = the track below shows through this one (it isn't drawn itself); "matted" = this one shows through the track above. */
  matteRole?: "matte" | "matted" | null;
}

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
  const items = (): MenuItem[] => [
    { id: "rename", label: "Rename", icon: "pencil", tip: "Type a new name for this track (or double-click the name)", onSelect: () => (setDraft(track.name), setEditing(true)) },
    { id: "up", label: "Move up", icon: "chevron-up", tip: "Move this track above its neighbour; clips on higher tracks draw on top", disabled: p.index >= p.count - 1, onSelect: () => p.onMove(1) },
    { id: "down", label: "Move down", icon: "chevron-down", tip: "Move this track below its neighbour; clips on lower tracks draw underneath", disabled: p.index <= 0, onSelect: () => p.onMove(-1) },
    {
      id: "kind",
      label: track.kind === "video" ? "Make it an adjustment track" : "Make it a video track",
      icon: "refresh-cw",
      tip: track.clips.length > 0 ? "Only empty tracks can change kind: remove or move the clips first" : track.kind === "video" ? "Adjustment tracks apply effects to everything beneath them instead of holding footage" : "Video tracks hold clips of footage, photos, text and visuals",
      disabled: track.clips.length > 0,
      onSelect: () => p.onKind(track.kind === "video" ? "adjust" : "video"),
    },
    { id: "remove", label: "Remove track", icon: "trash-2", tip: p.count <= 1 ? "An edit needs at least one track" : "Delete this track and its clips from the edit (you can undo it)", disabled: p.count <= 1, onSelect: p.onRemove },
  ];

  return (
    <div className={cx(styles.header, p.selected && styles.headerSelected)} onPointerDown={p.onSelect} data-track-header={track.id}>
      <Tooltip
        label={
          p.matteRole === "matte"
            ? "Matte: the track below shows through this one (not drawn itself)"
            : p.matteRole === "matted"
              ? "This track shows through the matte track above it"
              : track.kind === "video"
                ? "Video track: holds footage, photos, text and visuals"
                : "Adjustment track: its effects apply to everything beneath it"
        }
      >
        <Icon
          name={p.matteRole === "matte" ? "scan-line" : p.matteRole === "matted" ? "layers" : track.kind === "video" ? "film" : "sliders-horizontal"}
          size={14}
          className={styles.headerIcon}
          title={p.matteRole === "matte" ? "Matte: the track below shows through this one (not drawn itself)" : p.matteRole === "matted" ? "Shows through the track above" : undefined}
        />
      </Tooltip>
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
      <IconButton size="sm" icon={track.muted ? "volume-x" : "volume-2"} label={track.muted ? "Unmute track" : "Mute track"} data-tip={track.muted ? "Unmute: this track's clips are drawn (and heard) again" : "Mute: hide this track's clips from the preview and the export"} pressed={track.muted} onClick={() => p.onMute(!track.muted)} />
      <IconButton size="sm" icon="lock" label={track.locked ? "Unlock track" : "Lock track"} data-tip={track.locked ? "Unlock so clips on this track can be moved, trimmed and dropped on again" : "Lock to protect this track's clips from accidental moves, trims and drops"} pressed={track.locked} onClick={() => p.onLock(!track.locked)} />
      <MenuButton label={`Actions for ${track.name}`} icon="ellipsis" variant="ghost" size="sm" items={items} />
    </div>
  );
}
