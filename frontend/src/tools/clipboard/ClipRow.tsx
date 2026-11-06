import { memo, useRef, type MouseEvent } from "react";
import { Icon, IconButton, cx } from "@/components";
import { ClipKind, type ClipItem } from "@/lib/api";
import { saveTextAs } from "@/lib/saveText";
import { FileActions } from "@/tools/_kit";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { charCount, clipLabel } from "./clips";
import { useImageThumb } from "./useImageThumb";
import styles from "./ClipRow.module.css";

export interface ClipRowProps {
  item: ClipItem;
  /** DOM id (for aria-activedescendant). */
  domId: string;
  selected: boolean;
  compact?: boolean;
  /** 1-based position badge (popup number keys). */
  index?: number;
  now: number;
  onSelect: (id: string) => void;
  /** Single click in compact mode, double click otherwise. */
  onActivate: (id: string) => void;
  onCopy?: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onDelete?: (id: string) => void;
}

function Thumb({ item, size }: { item: ClipItem; size: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { url, failed } = useImageThumb(item.id, ref, true);
  return (
    <span ref={ref} className={styles.thumb} style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" className={styles.img} draggable={false} /> : <Icon name={failed ? "circle-alert" : "image"} size={18} />}
    </span>
  );
}

function ClipRowImpl({ item, domId, selected, compact, index, now, onSelect, onActivate, onCopy, onPin, onDelete }: ClipRowProps) {
  const isImage = item.kind === ClipKind.ClipImage;
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const meta = isImage
    ? `${item.width}×${item.height} · ${formatBytes(item.byteSize)}`
    : `${charCount(item).toLocaleString("en-US")} chars`;

  return (
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      aria-label={clipLabel(item)}
      data-clip-id={item.id}
      data-tip={compact ? "Click or press Enter to copy this again" : "Click to select; double-click or press Enter to copy it again"}
      data-tip-side="right"
      className={cx(styles.row, compact && styles.compact, selected && styles.selected)}
      onClick={() => (compact ? onActivate(item.id) : onSelect(item.id))}
      onDoubleClick={compact ? undefined : () => onActivate(item.id)}
      onMouseMove={compact && !selected ? () => onSelect(item.id) : undefined}
    >
      {index !== undefined && <span className={styles.index} data-tip={`Press ${index} to pick this item`}>{index}</span>}
      {isImage ? <Thumb item={item} size={compact ? 40 : 64} /> : null}
      <div className={styles.body}>
        {isImage ? (
          <span className={styles.imageTitle} data-tip="A copied image">Image</span>
        ) : (
          <span className={styles.preview}>{item.preview || "(whitespace)"}</span>
        )}
        <span className={styles.meta}>
          {item.pinned && <Icon name="pin" size={11} className={styles.pinGlyph} />}
          <span data-tip="When you last copied or used this item">{formatRelativeTime(item.lastUsedAt, now)}</span>
          <span aria-hidden="true">·</span>
          <span data-tip={isImage ? "Image size in pixels and file size" : "Number of characters"}>{meta}</span>
        </span>
      </div>
      {!compact && (
        <div className={styles.actions}>
          {onCopy && <IconButton size="sm" icon="copy" label="Copy" data-tip="Put this item back on the clipboard" tabIndex={-1} onClick={stop(() => onCopy(item.id))} />}
          {!isImage && item.text && <IconButton size="sm" icon="download" label="Save as…" data-tip="Save this text as a file" tabIndex={-1} onClick={stop(() => void saveTextAs(item.text, "clip.txt"))} />}
          {isImage && item.imagePath && (
            <span className={styles.fileActions} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <FileActions path={item.imagePath} moduleId="clipboard" />
            </span>
          )}
          {onPin && (
            <button
              type="button"
              tabIndex={-1}
              className={cx(styles.pinBtn, item.pinned && styles.pinned)}
              aria-label={item.pinned ? "Unpin" : "Pin"}
              aria-pressed={item.pinned}
              data-tip={item.pinned ? "Unpin: let this item be removed by the history limits again" : "Pin: keep this item even when old history is cleaned up"}
              onClick={stop(() => onPin(item.id, !item.pinned))}
            >
              <Icon name={item.pinned ? "pin-off" : "pin"} size={14} />
            </button>
          )}
          {onDelete && <IconButton size="sm" icon="trash-2" label="Delete" data-tip="Remove this item from the history" variant="danger" tabIndex={-1} onClick={stop(() => onDelete(item.id))} />}
        </div>
      )}
    </div>
  );
}

export const ClipRow = memo(ClipRowImpl);
