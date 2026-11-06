import { Badge, IconButton, cx } from "@/components";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { FileActions } from "@/tools/_kit/FileActions";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import { NotFromJob, dragHandler, type ItemHandlers } from "./ItemCard";
import { itemIcon, type LibItem } from "./items";
import { Icon } from "@/components";
import styles from "./Library.module.css";

function ListRow({ item, fallbackStop, selection, activeKey, moduleName, onClick, onForget, dragPaths }: ItemHandlers & { item: LibItem; fallbackStop: boolean }) {
  const behaviour = useResultBehaviour({ path: item.path, outputId: item.outputId || undefined, missing: item.missing });
  const selected = selection.has(item.key);
  const stop = item.key === activeKey || (fallbackStop && activeKey === "");
  return (
    <div
      {...behaviour}
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      tabIndex={stop ? 0 : -1}
      onDragStart={dragHandler(item, dragPaths, behaviour.onDragStart)}
      data-lib-key={item.key}
      className={cx(styles.row, selected && styles.selected, item.key === activeKey && styles.active, item.missing && styles.missingRow)}
      onClick={(e) => onClick(e, item)}
    >
      <span className={styles.rowKind} data-tip="File type">
        <Icon name={itemIcon(item)} size={16} />
      </span>
      <span className={styles.rowName} data-tip={item.path}>
        {item.name}
        {!item.registered ? <NotFromJob /> : null}
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
        <FileActions outputId={item.outputId || undefined} path={item.path} disabled={item.missing} moduleId="library" />
        {item.registered || item.missing ? (
          <IconButton size="sm" icon="trash-2" label="Forget" data-tip="Forget this entry (you can undo); the file itself is not deleted" onClick={() => onForget(item)} />
        ) : null}
      </span>
    </div>
  );
}

export interface ListViewProps extends ItemHandlers {
  items: LibItem[];
}

/** Dense rows: icon, name, tool, size, age and the file actions. */
export function ListView({ items, ...handlers }: ListViewProps) {
  return (
    <div className={styles.list} role="listbox" aria-label="Outputs" aria-multiselectable="true">
      {items.map((it, i) => (
        <ListRow key={it.key} item={it} fallbackStop={i === 0} {...handlers} />
      ))}
    </div>
  );
}
