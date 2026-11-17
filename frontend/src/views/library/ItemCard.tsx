import { memo, type DragEvent, type MouseEvent } from "react";
import { startPathsDrag } from "@/lib/fileDrag";
import { Badge, Icon, IconButton, cx } from "@/components";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { FileActions } from "@/tools/_kit/FileActions";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import type { CardSize } from "@/state/library";
import { FolderMosaic } from "./previews/FolderMosaic";
import { ItemThumb } from "./previews/ItemThumb";
import type { LibItem } from "./items";
import styles from "./Library.module.css";

/** What every card and row needs from the view that lists it. */
export interface ItemHandlers {
  selection: ReadonlySet<string>;
  /** The focused item (roving tab stop). */
  activeKey: string;
  moduleName: (id: string) => string;
  onClick: (e: MouseEvent, item: LibItem) => void;
  /** Double-click / Enter on a folder. */
  onEnterFolder?: (item: LibItem) => void;
  onForget: (item: LibItem) => void;
  /** The files a drag of this item carries (the whole selection when it is part of one). */
  dragPaths: (item: LibItem) => string[];
}

/** The drag handler for an item: the selection travels together, else the file's own behaviour. */
export function dragHandler(item: LibItem, dragPaths: (i: LibItem) => string[], own: (e: DragEvent<HTMLElement>) => void) {
  return (e: DragEvent<HTMLElement>) => {
    const paths = dragPaths(item);
    if (paths.length > 1 && !item.missing) startPathsDrag(e, paths);
    else own(e);
  };
}

export interface ItemCardProps extends Omit<ItemHandlers, "selection" | "activeKey"> {
  item: LibItem;
  size: CardSize;
  selected: boolean;
  /** The focused item. */
  active: boolean;
  /** The tab stop (the active card, or the first when nothing is active). */
  stop: boolean;
}

/** The "not from a job" dot of a file no tool made. */
export function NotFromJob() {
  return <span className={styles.notJob} role="img" aria-label="Not from a job" data-tip="Not from a job: this file is in your library folder, but no tool made it" />;
}

/**
 * One file or folder as a thumbnail card: draggable, double-click or Enter
 * opens it (a folder opens in place), Send to and the file actions below.
 */
export const ItemCard = memo(function ItemCard({ item, size, selected, active, stop, moduleName, onClick, onEnterFolder, onForget, dragPaths }: ItemCardProps) {
  const behaviour = useResultBehaviour({ path: item.path, outputId: item.outputId || undefined, missing: item.missing || item.isDir });
  const props = item.isDir
    ? {
        ...behaviour,
        onDoubleClick: () => onEnterFolder?.(item),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            onEnterFolder?.(item);
          }
        },
      }
    : behaviour;
  return (
    <div
      {...props}
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={stop ? 0 : -1}
      onDragStart={dragHandler(item, dragPaths, behaviour.onDragStart)}
      data-lib-key={item.key}
      className={cx(styles.card, styles[`size_${size}`], selected && styles.selected, active && styles.active, item.missing && styles.missingCard)}
      onClick={(e) => onClick(e, item)}
    >
      <div className={styles.cardThumb}>
        {item.isDir ? <FolderMosaic item={item} /> : <ItemThumb item={item} play={size !== "s"} />}
        {!item.registered && !item.isDir ? <NotFromJob /> : null}
      </div>
      <div className={styles.cardBody}>
        <span className={styles.cardName} data-tip={item.path}>
          {item.isDir ? <Icon name="folder" size={12} /> : null}
          {item.name}
        </span>
        <span className={styles.cardMeta}>
          {item.missing ? (
            <Badge tone="warn" tip="This file was moved or deleted outside the app">
              MISSING
            </Badge>
          ) : item.isDir ? null : (
            <>
              {item.moduleId ? <span data-tip="The tool that made this file">{moduleName(item.moduleId)}</span> : null}
              <span data-tip="File size">{formatBytes(item.sizeBytes)}</span>
              {size !== "s" && item.at ? <span data-tip={new Date(item.at).toLocaleString()}>{formatRelativeTime(item.at)}</span> : null}
            </>
          )}
        </span>
      </div>
      {item.isDir ? null : (
        <div className={styles.cardActions}>
          <FileActions outputId={item.outputId || undefined} path={item.path} disabled={item.missing} moduleId="library" />
          {item.registered ? (
            <IconButton size="sm" icon="trash-2" label="Forget" data-tip="Forget this entry (you can undo); the file itself is not deleted" onClick={() => onForget(item)} />
          ) : null}
        </div>
      )}
    </div>
  );
});
