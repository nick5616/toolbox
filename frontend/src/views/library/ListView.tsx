import { memo } from "react";
import { Badge, Button, IconButton, cx } from "@/components";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { FileActions } from "@/tools/_kit/FileActions";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import { NotFromJob, dragHandler, folderLine, type ItemHandlers } from "./ItemCard";
import { HitMeta, Snippet } from "./HitBits";
import { itemIcon, type LibItem } from "./items";
import { Icon } from "@/components";
import styles from "./Library.module.css";
import searchStyles from "./Search.module.css";

const ListRow = memo(function ListRow({ item, selected, active, stop, moduleName, onClick, onForget, onOpenProject, folderRoot, dragPaths }: Omit<ItemHandlers, "selection" | "activeKey"> & { item: LibItem; selected: boolean; active: boolean; stop: boolean }) {
  const isProject = !!item.hit?.projectId;
  const behaviour = useResultBehaviour({ path: item.path, outputId: item.outputId || undefined, missing: item.missing, onOpen: isProject ? () => onOpenProject?.(item) : undefined });
  return (
    <div
      {...behaviour}
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={stop ? 0 : -1}
      onDragStart={dragHandler(item, dragPaths, behaviour.onDragStart)}
      data-lib-key={item.key}
      className={cx(styles.row, item.hit && searchStyles.rowHit, selected && styles.selected, active && styles.active, item.missing && styles.missingRow)}
      onClick={(e) => onClick(e, item)}
    >
      <span className={styles.rowKind} data-tip="File type">
        <Icon name={itemIcon(item)} size={16} />
      </span>
      <span className={cx(styles.rowName, item.hit && searchStyles.rowStack)} data-tip={item.path}>
        <span className={searchStyles.rowTitle}>
          {item.name}
          {!item.registered && !isProject ? <NotFromJob /> : null}
          {item.hit ? <HitMeta item={item} /> : null}
        </span>
        {folderRoot !== undefined ? <span className={searchStyles.folderLine}>{folderLine(item, folderRoot)}</span> : null}
        {item.hit?.snippet ? <Snippet text={item.hit.snippet} /> : null}
      </span>
      {item.missing ? (
        <Badge tone="warn" tip="This file was moved or deleted outside the app">
          MISSING
        </Badge>
      ) : null}
      <span className={styles.rowModule} data-tip="The tool that made this file">
        {item.moduleId ? moduleName(item.moduleId) : ""}
      </span>
      <span className={styles.mono} data-tip="File size">
        {item.missing ? "" : formatBytes(item.sizeBytes)}
      </span>
      <span className={styles.mono} data-tip="When it was made">
        {item.at ? formatRelativeTime(item.at) : ""}
      </span>
      <span className={styles.rowActions}>
        {isProject ? (
          <Button size="sm" variant="ghost" icon="external-link" data-tip="Open this project in its tool" onClick={() => onOpenProject?.(item)}>
            Open project
          </Button>
        ) : (
          <FileActions outputId={item.outputId || undefined} path={item.path} disabled={item.missing} moduleId="library" />
        )}
        {(item.registered || item.missing) && !isProject ? (
          <IconButton size="sm" icon="trash-2" label="Forget" data-tip="Forget this entry (you can undo); the file itself is not deleted" onClick={() => onForget(item)} />
        ) : null}
      </span>
    </div>
  );
});

export interface ListViewProps extends ItemHandlers {
  items: LibItem[];
}

/** Dense rows: icon, name, tool, size, age and the file actions. */
export function ListView({ items, selection, activeKey, ...handlers }: ListViewProps) {
  return (
    <div className={styles.list} role="listbox" aria-label="Outputs" aria-multiselectable="true">
      {items.map((it, i) => (
        <ListRow key={it.key} item={it} selected={selection.has(it.key)} active={it.key === activeKey} stop={it.key === activeKey || (i === 0 && activeKey === "")} {...handlers} />
      ))}
    </div>
  );
}
