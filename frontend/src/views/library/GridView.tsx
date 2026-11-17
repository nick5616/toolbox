import { cx } from "@/components";
import type { CardSize } from "@/state/library";
import { ItemCard, type ItemHandlers } from "./ItemCard";
import type { LibItem } from "./items";
import styles from "./Library.module.css";

export interface GridViewProps extends ItemHandlers {
  items: LibItem[];
  size: CardSize;
  label?: string;
}

/** Thumbnail cards in a wrapping grid (S, M or L). */
export function GridView({ items, size, label = "Files", selection, activeKey, ...handlers }: GridViewProps) {
  return (
    <div className={cx(styles.grid, styles[`grid_${size}`])} role="listbox" aria-label={label} aria-multiselectable="true">
      {items.map((it, i) => (
        <ItemCard key={it.key} item={it} size={size} selected={selection.has(it.key)} active={it.key === activeKey} stop={it.key === activeKey || (i === 0 && activeKey === "")} {...handlers} />
      ))}
    </div>
  );
}
