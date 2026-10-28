import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { cx } from "@/components";
import { deleteTiles, moveBy, moveToIndex, rangeBetween, type Tile } from "./organize";
import { usePdfThumb, useSeen } from "./useThumb";
import styles from "./PageGrid.module.css";

export interface PageGridProps {
  path: string;
  password: string;
  tiles: Tile[];
  selected: ReadonlySet<number>;
  focusPage: number;
  onTiles: (t: Tile[]) => void;
  onSelected: (s: Set<number>) => void;
  onFocus: (page: number) => void;
}

interface DropMark {
  page: number;
  after: boolean;
}

function PageTile({
  path,
  password,
  tile,
  index,
  selected,
  focused,
  mark,
  ...handlers
}: {
  path: string;
  password: string;
  tile: Tile;
  index: number;
  selected: boolean;
  focused: boolean;
  mark: "before" | "after" | null;
  onClick: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  onFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const src = usePdfThumb(path, tile.page, 240, password, seen);
  const label = tile.rotate ? `Page ${tile.page}, rotated ${tile.rotate}°` : `Page ${tile.page}`;
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={label}
      data-index={index}
      tabIndex={focused ? 0 : -1}
      draggable
      className={cx(
        styles.tile,
        selected && styles.selected,
        mark === "before" && styles.dropBefore,
        mark === "after" && styles.dropAfter,
      )}
      {...handlers}
    >
      <div className={styles.thumb}>
        {src ? (
          <img src={src} alt="" draggable={false} style={{ transform: `rotate(${tile.rotate}deg)` }} />
        ) : (
          <span className={styles.placeholder} />
        )}
      </div>
      <span className={styles.num}>{tile.page}</span>
      {tile.rotate !== 0 && <span className={styles.badge}>{tile.rotate}°</span>}
    </div>
  );
}

/** Thumbnail grid for Organize pages: selection, keyboard moves and drag reordering. */
export function PageGrid({ path, password, tiles, selected, focusPage, onTiles, onSelected, onFocus }: PageGridProps) {
  const anchor = useRef(focusPage);
  const drag = useRef<number[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<DropMark | null>(null);

  const focusTile = (page: number) => {
    onFocus(page);
    const i = tiles.findIndex((t) => t.page === page);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus());
  };

  const columns = () => {
    const tpl = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns : "";
    const n = tpl.split(" ").filter(Boolean).length;
    return n > 0 ? n : 1;
  };

  const select = (page: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.shiftKey) {
      onSelected(new Set(rangeBetween(tiles, anchor.current, page)));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      onSelected(next);
      anchor.current = page;
    } else {
      onSelected(new Set([page]));
      anchor.current = page;
    }
    onFocus(page);
  };

  const onKeyDown = (e: KeyboardEvent, page: number, index: number) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelected(new Set(tiles.map((t) => t.page)));
      return;
    }
    const go = (i: number) => {
      const t = tiles[Math.max(0, Math.min(tiles.length - 1, i))];
      if (!t) return;
      e.preventDefault();
      focusTile(t.page);
      if (e.shiftKey) onSelected(new Set(rangeBetween(tiles, anchor.current, t.page)));
    };
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (e.altKey) {
          e.preventDefault();
          const ids = selected.has(page) ? selected : new Set([page]);
          onTiles(moveBy(tiles, ids, dir));
          focusTile(page);
        } else go(index + dir);
        break;
      }
      case "ArrowUp":
        go(index - columns());
        break;
      case "ArrowDown":
        go(index + columns());
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(tiles.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(page, e);
        break;
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        const ids = selected.has(page) ? selected : new Set([page]);
        const next = deleteTiles(tiles, ids);
        onTiles(next);
        onSelected(new Set());
        const keep = next[Math.min(index, next.length - 1)];
        if (keep) focusTile(keep.page);
        break;
      }
    }
  };

  const dropIndex = (m: DropMark) => tiles.findIndex((t) => t.page === m.page) + (m.after ? 1 : 0);

  return (
    <div
      ref={gridRef}
      role="listbox"
      aria-label="Pages"
      aria-multiselectable="true"
      className={styles.grid}
    >
      {tiles.map((tile, index) => (
        <PageTile
          key={tile.page}
          path={path}
          password={password}
          tile={tile}
          index={index}
          selected={selected.has(tile.page)}
          focused={tile.page === focusPage}
          mark={mark?.page === tile.page ? (mark.after ? "after" : "before") : null}
          onClick={(e) => select(tile.page, e)}
          onFocus={() => onFocus(tile.page)}
          onKeyDown={(e) => onKeyDown(e, tile.page, index)}
          onDragStart={(e) => {
            drag.current = selected.has(tile.page) ? [...selected] : [tile.page];
            e.dataTransfer?.setData("text/plain", String(tile.page));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (drag.current.length === 0) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMark({ page: tile.page, after: e.clientX > r.left + r.width / 2 });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (mark && drag.current.length > 0) {
              onTiles(moveToIndex(tiles, new Set(drag.current), dropIndex(mark)));
            }
            drag.current = [];
            setMark(null);
          }}
          onDragEnd={() => {
            drag.current = [];
            setMark(null);
          }}
        />
      ))}
    </div>
  );
}
