/**
 * The custom ease editor (Phase 21 SPEC §B3): a 120 × 80 curve with two
 * draggable handles (the cubic-bezier's control points). Arrow keys nudge the
 * focused handle (Shift = bigger steps). The y range widens to show overshoot;
 * it stays fixed while a handle is being dragged so the pointer never jumps.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { CURVE_H, CURVE_W, curvePath, curveRange, curveToPx, moveHandle, nudgeHandle, pxToCurve, type Bez, type YRange } from "./easeCurve";
import styles from "./inspector.module.css";

export interface EaseCurveEditorProps {
  value: Bez;
  onChange(next: Bez): void;
}

const STEP = 0.02;
const BIG_STEP = 0.1;

export function EaseCurveEditor({ value, onChange }: EaseCurveEditorProps) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ handle: 1 | 2; pointerId: number; range: YRange } | null>(null);
  const [dragging, setDragging] = useState(false);
  const range = drag.current ? drag.current.range : curveRange(value);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    return { x: ((e.clientX - r.left) * CURVE_W) / r.width, y: ((e.clientY - r.top) * CURVE_H) / r.height };
  };

  const down = (handle: 1 | 2) => (e: RPointerEvent<SVGCircleElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { handle, pointerId: e.pointerId, range: curveRange(value) };
    setDragging(true);
  };
  const move = (e: RPointerEvent<SVGCircleElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    onChange(moveHandle(value, d.handle, pxToCurve(toLocal(e), d.range)));
  };
  const up = (e: RPointerEvent<SVGCircleElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setDragging(false);
  };
  const key = (handle: 1 | 2) => (e: KeyboardEvent<SVGCircleElement>) => {
    const s = e.shiftKey ? BIG_STEP : STEP;
    const d: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] };
    const delta = d[e.key];
    if (!delta) return;
    e.preventDefault();
    onChange(nudgeHandle(value, handle, delta[0], delta[1]));
  };

  const p0 = curveToPx({ x: 0, y: 0 }, range);
  const p3 = curveToPx({ x: 1, y: 1 }, range);
  const h1 = curveToPx({ x: value[0], y: value[1] }, range);
  const h2 = curveToPx({ x: value[2], y: value[3] }, range);
  const handles: Array<{ n: 1 | 2; p: { x: number; y: number }; a: { x: number; y: number }; v: [number, number] }> = [
    { n: 1, p: h1, a: p0, v: [value[0], value[1]] },
    { n: 2, p: h2, a: p3, v: [value[2], value[3]] },
  ];

  return (
    <svg
      ref={svg}
      className={styles.curve}
      width={CURVE_W}
      height={CURVE_H}
      viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
      data-testid="ease-curve"
      data-dragging={dragging || undefined}
      role="group"
      aria-label="Custom ease curve"
      data-tip="Drag the two handles to shape how the value moves between keys; arrow keys nudge the focused handle"
    >
      <line className={styles.curveGrid} x1={p0.x} y1={p0.y} x2={p3.x} y2={p3.y} />
      <line className={styles.curveGrid} x1={p0.x} y1={p3.y} x2={p3.x} y2={p3.y} />
      <line className={styles.curveGrid} x1={p0.x} y1={p0.y} x2={p3.x} y2={p0.y} />
      {handles.map((h) => (
        <line key={`s${h.n}`} className={styles.curveStem} x1={h.a.x} y1={h.a.y} x2={h.p.x} y2={h.p.y} />
      ))}
      <path className={styles.curveLine} d={curvePath(value, range)} data-testid="ease-curve-path" />
      {handles.map((h) => (
        <circle
          key={h.n}
          className={styles.curveHandle}
          data-testid={`ease-handle-${h.n}`}
          cx={h.p.x}
          cy={h.p.y}
          r={5}
          tabIndex={0}
          role="slider"
          aria-label={`Curve handle ${h.n}`}
          aria-valuetext={`x ${h.v[0].toFixed(2)}, y ${h.v[1].toFixed(2)}`}
          aria-valuemin={-1}
          aria-valuemax={2}
          aria-valuenow={h.v[1]}
          data-tip={`Handle ${h.n}: drag, or use the arrow keys (Shift for bigger steps)`}
          onPointerDown={down(h.n)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={key(h.n)}
        />
      ))}
    </svg>
  );
}
