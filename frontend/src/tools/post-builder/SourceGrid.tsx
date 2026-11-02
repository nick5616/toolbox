import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { cx, Icon } from "@/components";
import type { PostSourceFile } from "@/lib/api";
import { clickSelection, usedNumbers } from "./pool";
import { formatDuration, loadClipDuration, loadSourceThumb } from "./sourceThumbs";
import { startSourceDrag } from "./sourceDrag";
import styles from "./SourceGrid.module.css";

// The grid of a post's source pool (SPEC.md §B13.4), shared by Post Builder,
// Photo Composer and Video Editor. Props are FROZEN (Wave C0).

export interface SourceGridProps {
  sources: PostSourceFile[];
  /** Selected paths. */
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Paths to highlight (used by the selected slide). */
  highlighted?: ReadonlySet<string>;
  /** Slide ID → 1-based slide number, for "used in 2, 5" badges. */
  slideNumbers?: Readonly<Record<string, number>>;
  /** Double-click or Enter on a source. */
  onActivate?: (path: string) => void;
  /** Allow dragging selected sources out (startSourceDrag). Default true. */
  draggable?: boolean;
  /** Tile edge in px (default 96). */
  tileSize?: number;
  /** Shown when there are no sources. */
  emptyLabel?: string;
}

/** True once the element has been near the viewport (always true without IntersectionObserver). */
function useSeen(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

interface TileProps {
  source: PostSourceFile;
  id: string;
  size: number;
  selected: boolean;
  highlighted: boolean;
  active: boolean;
  used: number[];
  onPointerDown: (e: RPointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

function Tile({ source, id, size, selected, highlighted, active, used, onPointerDown, onClick, onDoubleClick }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const { path, kind, missing } = source;

  useEffect(() => {
    if (!seen || missing) return;
    let off = false;
    loadSourceThumb(path, kind).then(
      (u) => !off && setUrl(u),
      () => !off && setFailed(true),
    );
    if (kind === "clip") void loadClipDuration(path).then((ms) => !off && setDuration(ms));
    return () => {
      off = true;
    };
  }, [seen, path, kind, missing]);

  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={source.name}
      title={source.rel || source.path}
      data-path={path}
      data-active={active || undefined}
      data-highlighted={highlighted || undefined}
      className={cx(styles.tile, selected && styles.selected, highlighted && styles.highlighted, missing && styles.missing, active && styles.active)}
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {url ? (
        <img src={url} alt="" className={styles.img} draggable={false} />
      ) : (
        <span className={styles.placeholder} aria-hidden="true">
          <Icon name={failed || missing ? "triangle-alert" : kind === "clip" ? "film" : "image"} size={18} />
        </span>
      )}
      <span className={styles.kind} title={kind === "clip" ? "Clip" : "Photo"}>
        <Icon name={kind === "clip" ? "film" : "image"} size={11} />
        {kind === "clip" && duration > 0 && <span data-testid="duration">{formatDuration(duration)}</span>}
      </span>
      {missing && <span className={styles.flag}>Missing</span>}
      {used.length > 0 && <span className={styles.used}>Used in {used.join(", ")}</span>}
    </div>
  );
}

export function SourceGrid({
  sources,
  selected,
  onSelectionChange,
  highlighted,
  slideNumbers,
  onActivate,
  draggable = true,
  tileSize = 96,
  emptyLabel,
}: SourceGridProps) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef("");
  const [activeIdx, setActiveIdx] = useState(0);
  const order = sources.map((s) => s.path);
  const active = Math.min(activeIdx, Math.max(0, sources.length - 1));

  if (sources.length === 0) return <p className={styles.empty}>{emptyLabel ?? "No sources"}</p>;

  const choose = (path: string, mods: { shift: boolean; toggle: boolean }) => {
    const r = clickSelection(order, selected, anchor.current, path, mods);
    anchor.current = r.anchor;
    onSelectionChange(r.selected);
  };

  const columns = (): number => {
    const tiles = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const top = tiles[0]?.offsetTop ?? 0;
    const n = tiles.findIndex((t) => t.offsetTop !== top);
    return n > 0 ? n : 1;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (to: number) => {
      const i = Math.min(Math.max(to, 0), sources.length - 1);
      e.preventDefault();
      setActiveIdx(i);
      const path = order[i]!;
      if (e.shiftKey) choose(path, { shift: true, toggle: false });
      else if (!e.ctrlKey && !e.metaKey) choose(path, { shift: false, toggle: false });
      document.getElementById(`${base}-${i}`)?.scrollIntoView?.({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowRight":
        return move(active + 1);
      case "ArrowLeft":
        return move(active - 1);
      case "ArrowDown":
        return move(active + columns());
      case "ArrowUp":
        return move(active - columns());
      case "Home":
        return move(0);
      case "End":
        return move(sources.length - 1);
      case "Enter":
        if (onActivate && order[active]) {
          e.preventDefault();
          onActivate(order[active]!);
        }
        return;
      case " ":
        e.preventDefault();
        return choose(order[active]!, { shift: false, toggle: true });
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onSelectionChange(new Set(order));
        }
        return;
    }
  };

  const down = (e: RPointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    setActiveIdx(index);
    if (!draggable) return;
    const path = order[index]!;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return; // modifiers select; they don't drag
    let paths: string[];
    if (selected.has(path)) {
      paths = [...selected].filter((p) => order.includes(p));
    } else {
      paths = [path];
      anchor.current = path;
      onSelectionChange(new Set([path]));
    }
    startSourceDrag(paths, e);
  };

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Sources"
      aria-multiselectable="true"
      aria-activedescendant={`${base}-${active}`}
      tabIndex={0}
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(auto-fill, ${tileSize}px)` }}
      onKeyDown={onKeyDown}
    >
      {sources.map((s, i) => (
        <Tile
          key={s.path}
          source={s}
          id={`${base}-${i}`}
          size={tileSize}
          selected={selected.has(s.path)}
          highlighted={!!highlighted?.has(s.path)}
          active={i === active}
          used={slideNumbers ? usedNumbers(s, slideNumbers) : []}
          onPointerDown={(e) => down(e, i)}
          onClick={(e) => {
            setActiveIdx(i);
            choose(s.path, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
          }}
          onDoubleClick={() => onActivate?.(s.path)}
        />
      ))}
    </div>
  );
}
