import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Icon, IconButton, Spinner, TextField, cx } from "@/components";
import { FilesService, type ComposerLayer } from "@/lib/api";
import { displayToDocIndex, dropIndex } from "./logic";
import styles from "./LayersPanel.module.css";

export interface LayersPanelProps {
  layers: readonly ComposerLayer[];
  selectedId: string | null;
  busyIds: ReadonlySet<string>;
  /** Extra text beside a busy layer's spinner ("queued", "42%"). */
  busyLabels?: Readonly<Record<string, string>>;
  /** Every selected layer when several are (Ctrl/Cmd+click toggles, Shift+click selects a range). */
  multi?: ReadonlySet<string>;
  onSelect: (id: string, mods?: { toggle: boolean; range: boolean }) => void;
  onPatch: (id: string, patch: Partial<ComposerLayer>) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** index = document position (0 = bottom). */
  onReorder: (id: string, index: number) => void;
}

const thumbCache = new Map<string, string>();

function Thumb({ layer }: { layer: ComposerLayer }) {
  const path = layer.kind === "image" ? layer.image?.ref.path ?? "" : "";
  const [src, setSrc] = useState(() => thumbCache.get(path) ?? "");
  useEffect(() => {
    if (!path) return;
    const hit = thumbCache.get(path);
    if (hit) {
      setSrc(hit);
      return;
    }
    let off = false;
    FilesService.ImageThumb(path, 96)
      .then((url) => {
        thumbCache.set(path, url);
        if (!off) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [path]);
  if (layer.kind === "text") {
    return (
      <span className={styles.thumb}>
        <Icon name="type" size={16} />
      </span>
    );
  }
  return <span className={styles.thumb}>{src ? <img src={src} alt="" draggable={false} /> : <Icon name="image" size={16} />}</span>;
}

interface DragState {
  id: string;
  from: number;
  startY: number;
  active: boolean;
  /** Insert position among the other rows (0 = above the first). */
  target: number;
}

/** The layer list, topmost layer first. Drag a row to reorder. */
export function LayersPanel({ layers, selectedId, busyIds, busyLabels, multi, onSelect, onPatch, onDuplicate, onDelete, onReorder }: LayersPanelProps) {
  const display = [...layers].reverse();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const centers = (): number[] =>
    display.map((l) => {
      const r = rows.current.get(l.id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : 0;
    });

  const onDown = (e: RPointerEvent<HTMLLIElement>, l: ComposerLayer, index: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const toggle = e.ctrlKey || e.metaKey;
    onSelect(l.id, { toggle, range: e.shiftKey });
    if (toggle || e.shiftKey) return;
    const d: DragState = { id: l.id, from: index, startY: e.clientY, active: false, target: index };
    dragRef.current = d;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLLIElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active && Math.abs(e.clientY - d.startY) < 4) return;
    d.active = true;
    d.target = dropIndex(centers(), d.from, e.clientY);
    setDrag({ ...d });
  };
  const onUp = (e: RPointerEvent<HTMLLIElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    if (d?.active && d.target !== d.from) onReorder(d.id, displayToDocIndex(layers.length, d.target));
  };

  if (display.length === 0) {
    return <p className={styles.empty} data-tip="Use Add photo or Add text in the toolbar">No layers yet. Add a photo or some text.</p>;
  }

  const lineBefore = drag?.active ? (() => {
    const others = display.filter((l) => l.id !== drag.id);
    return others[drag.target]?.id ?? "";
  })() : "";

  return (
    <ul className={styles.list} aria-label="Layers">
      {display.map((l, i) => (
        <li
          key={l.id}
          ref={(el) => {
            if (el) rows.current.set(l.id, el);
            else rows.current.delete(l.id);
          }}
          className={cx(styles.row, (l.id === selectedId || multi?.has(l.id)) && styles.selected, l.hidden && styles.hidden, drag?.active && drag.id === l.id && styles.dragging, lineBefore === l.id && styles.dropBefore)}
          data-layer-id={l.id}
          aria-current={l.id === selectedId || undefined}
          onPointerDown={(e) => onDown(e, l, i)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <Thumb layer={l} />
          {renaming === l.id ? (
            <TextField
              size="sm"
              autoFocus
              aria-label="Layer name"
              data-tip="New layer name; press Enter to keep it"
              defaultValue={l.name}
              wrapperClassName={styles.rename}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) onPatch(l.id, { name: v.slice(0, 120) });
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span className={styles.name} onDoubleClick={() => setRenaming(l.id)} title="Click to select (Ctrl or Shift for several), drag to reorder, double-click to rename">
              {l.name}
            </span>
          )}
          {busyIds.has(l.id) && (
            <>
              {busyLabels?.[l.id] && <span className={styles.busyLabel}>{busyLabels[l.id]}</span>}
              <span data-tip="Cutting out the subject" style={{ display: "contents" }}><Spinner size={14} label="Removing background" /></span>
            </>
          )}
          <span className={styles.actions}>
            <IconButton size="sm" icon={l.hidden ? "eye-off" : "eye"} label={l.hidden ? "Show layer" : "Hide layer"} data-tip={l.hidden ? "Show this layer on the canvas again" : "Hide this layer from the canvas and the export"} onClick={() => onPatch(l.id, { hidden: !l.hidden })} />
            <IconButton size="sm" icon="lock" label={l.locked ? "Unlock layer" : "Lock layer"} data-tip={l.locked ? "Allow this layer to be moved and edited again" : "Stop this layer from being moved by accident"} pressed={l.locked} onClick={() => onPatch(l.id, { locked: !l.locked })} />
            <IconButton size="sm" icon="copy" label="Duplicate layer" data-tip="Make a copy of this layer" kbd="Ctrl+D" onClick={() => onDuplicate(l.id)} />
            <IconButton size="sm" icon="trash-2" label="Delete layer" data-tip="Remove this layer from the composition" kbd="Delete" onClick={() => onDelete(l.id)} />
          </span>
        </li>
      ))}
    </ul>
  );
}
