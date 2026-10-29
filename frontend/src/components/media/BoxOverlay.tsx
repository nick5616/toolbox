import { useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { cx } from "../cx";
import { clamp, MIN_BOX, newManualBoxId, normalizeBox, resizeBox, type Corner } from "./logic";
import type { Box, ContentRect } from "./types";
import styles from "./BoxOverlay.module.css";

export interface BoxOverlayProps {
  rect: ContentRect;
  boxes: Box[];
  onChange?: (boxes: Box[]) => void;
  editable?: boolean;
  /** When true, dragging on an empty area draws a new manual box. */
  drawMode?: boolean;
  selectedId?: string;
  onSelect?: (id: string | undefined) => void;
  /** Optional per-box fill preview (e.g. the redaction effect), drawn under the outline. */
  renderFill?: (box: Box) => React.ReactNode;
}

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

interface Gesture {
  kind: "draw" | "resize";
  pointerId: number;
  x0: number;
  y0: number;
  id?: string;
  corner?: Corner;
  moved: boolean;
}

/** Selectable, toggleable, resizable boxes over a picture (SPEC.md §3.11). */
export function BoxOverlay({ rect, boxes, onChange, editable = false, drawMode = false, selectedId, onSelect, renderFill }: BoxOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [innerSel, setInnerSel] = useState<string | undefined>(undefined);
  const selected = onSelect ? selectedId : (selectedId ?? innerSel);

  const live = useRef({ boxes, onChange });
  live.current = { boxes, onChange };

  const select = (id: string | undefined) => {
    setInnerSel(id);
    onSelect?.(id);
  };

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = root.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  const onRootDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!editable || e.button !== 0) return;
    root.current?.focus({ preventScroll: true });
    if (e.target !== e.currentTarget) return;
    select(undefined);
    if (!drawMode) return;
    const p = pos(e);
    gesture.current = { kind: "draw", pointerId: e.pointerId, x0: p.x, y0: p.y, moved: false };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    root.current?.setPointerCapture?.(e.pointerId);
  };

  const onCornerDown = (e: RPointerEvent<HTMLDivElement>, id: string, corner: Corner) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: "resize", pointerId: e.pointerId, x0: 0, y0: 0, id, corner, moved: false };
    root.current?.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const p = pos(e);
    g.moved = true;
    if (g.kind === "draw") {
      setDraft(normalizeBox(g.x0, g.y0, p.x, p.y));
    } else if (g.id && g.corner) {
      const { boxes: bs, onChange: cb } = live.current;
      cb?.(bs.map((b) => (b.id === g.id && g.corner ? resizeBox(b, g.corner, p.x, p.y) : b)));
    }
  };

  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    root.current?.releasePointerCapture?.(e.pointerId);
    if (g.kind === "draw") {
      const p = pos(e);
      const nb = normalizeBox(g.x0, g.y0, p.x, p.y);
      setDraft(null);
      if (nb.w >= MIN_BOX && nb.h >= MIN_BOX) {
        const box: Box = { id: newManualBoxId(), ...nb, kind: "manual", enabled: true };
        live.current.onChange?.([...live.current.boxes, box]);
        select(box.id);
      }
    }
  };

  const onBoxClick = (b: Box) => {
    if (!editable) return;
    select(b.id);
    live.current.onChange?.(live.current.boxes.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editable || !selected) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const b = boxes.find((x) => x.id === selected);
    if (!b || b.kind !== "manual") return;
    e.preventDefault();
    e.stopPropagation();
    onChange?.(boxes.filter((x) => x.id !== selected));
    select(undefined);
  };

  return (
    <div
      ref={root}
      data-testid="box-overlay"
      tabIndex={editable ? 0 : undefined}
      className={cx(styles.root, editable && styles.editable, editable && drawMode && styles.draw)}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerDown={onRootDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      {boxes.map((b) => {
        const isSel = b.id === selected;
        return (
          <div
            key={b.id}
            data-testid={`box-${b.id}`}
            role={editable ? "button" : undefined}
            aria-pressed={editable ? b.enabled : undefined}
            aria-label={b.label ?? `${b.kind} box`}
            className={cx(styles.box, b.enabled ? styles.on : styles.off, isSel && styles.selected)}
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.w * 100}%`,
              height: `${b.h * 100}%`,
            }}
            onClick={() => onBoxClick(b)}
          >
            {b.enabled && renderFill && <div className={styles.fill}>{renderFill(b)}</div>}
            {b.label && <span className={styles.label}>{b.label}</span>}
            {editable &&
              isSel &&
              CORNERS.map((c) => (
                <div
                  key={c}
                  data-testid={`handle-${b.id}-${c}`}
                  className={cx(styles.corner, styles[c])}
                  onPointerDown={(e) => onCornerDown(e, b.id, c)}
                  onClick={(e) => e.stopPropagation()}
                />
              ))}
          </div>
        );
      })}
      {draft && (
        <div
          className={cx(styles.box, styles.on, styles.draft)}
          style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
        />
      )}
    </div>
  );
}
