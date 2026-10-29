import { useRef, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { clampCropCenter, cropWindow } from "./logic";
import type { ContentRect } from "./types";
import styles from "./CropOverlay.module.css";

export interface CropOverlayProps {
  rect: ContentRect;
  /** Target width / height, e.g. 9/16. */
  aspect: number;
  /** Source width / height (display size). */
  sourceAspect: number;
  /** Centre of the window, 0..1. */
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}

const NUDGE = 0.01;

/** A draggable crop window with the outside dimmed (SPEC.md §3.11). */
export function CropOverlay({ rect, aspect, sourceAspect, x, y, onChange }: CropOverlayProps) {
  const win = cropWindow(aspect, sourceAspect);
  const c = clampCropCenter(x, y, win);
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    // Offset between the pointer and the window centre so it doesn't jump.
    drag.current = {
      pointerId: e.pointerId,
      dx: (e.clientX - r.left) / r.width - c.x,
      dy: (e.clientY - r.top) / r.height - c.y,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const r = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    const next = clampCropCenter((e.clientX - r.left) / r.width - d.dx, (e.clientY - r.top) / r.height - d.dy, win);
    onChange(next.x, next.y);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? NUDGE * 5 : NUDGE;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const next = clampCropCenter(c.x + dx, c.y + dy, win);
    onChange(next.x, next.y);
  };

  return (
    <div
      data-testid="crop-overlay"
      className={styles.root}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div
        data-testid="crop-window"
        role="slider"
        tabIndex={0}
        aria-label="Crop position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(c.x * 100)}
        className={styles.window}
        style={{
          left: `${(c.x - win.w / 2) * 100}%`,
          top: `${(c.y - win.h / 2) * 100}%`,
          width: `${win.w * 100}%`,
          height: `${win.h * 100}%`,
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      />
    </div>
  );
}
