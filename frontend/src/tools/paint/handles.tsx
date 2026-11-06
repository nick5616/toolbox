/**
 * On-canvas handles drawn over the canvas (SPEC §1.2): the transform box with
 * scale and rotate handles, the Distort corners and Warp mesh points, and the
 * QuickShape handles. They sit in an SVG that ignores the pointer except on
 * the handles themselves; the canvas below keeps the body drag.
 */
import { useRef, type PointerEvent } from "react";
import type { PaintEngineExt } from "@/paint/engine/engine";
import type { PaintEngine, Point } from "@/paint/engine/types";
import { moveHandle, shapeHandles, type Shape } from "@/paint/guides/quickshape";
import { useEngineEvents } from "./context";
import { HANDLES, centreOf, handlePoint, movePoint, rotateDrag, scaleHandle, type Affine, type HandleId } from "./transformMath";
import ed from "./editor.module.css";

type Ext = PaintEngine & Partial<PaintEngineExt>;

const ROTATE_GAP = 30;

/** Pointer drag on one handle: `onMove` gets canvas coordinates. */
function useHandleDrag(engine: PaintEngine, onStart: (at: Point) => void, onMove: (at: Point, e: PointerEvent) => void, onEnd?: () => void) {
  const canvasPoint = (e: PointerEvent): Point => {
    const r = (e.currentTarget as SVGElement).ownerSVGElement?.getBoundingClientRect();
    return engine.view.screenToCanvas({ x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) });
  };
  return {
    onPointerDown(e: PointerEvent) {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      onStart(canvasPoint(e));
    },
    onPointerMove(e: PointerEvent) {
      if (!(e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) return;
      onMove(canvasPoint(e), e);
    },
    onPointerUp(e: PointerEvent) {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      onEnd?.();
    },
  };
}

function Dot({ s, kind, label, drag }: { s: Point; kind?: "rot" | "mesh"; label: string; drag: ReturnType<typeof useHandleDrag> }) {
  return <circle cx={s.x} cy={s.y} r={kind === "mesh" ? 5 : 7} className={`${ed.handle} ${kind === "rot" ? ed.handleRot : ""}`} role="slider" aria-label={label} data-testid="transform-handle" {...drag} />;
}

/** The transform box for free / uniform; corners for distort; a mesh for warp. */
export function TransformHandles({ engine }: { engine: PaintEngine }) {
  useEngineEvents(engine, ["change", "view"]);
  const e = engine as Ext;
  const st = engine.transform.active ? e.transformState?.() ?? null : null;
  if (!st) return null;
  const toS = (p: Point) => engine.view.canvasToScreen(p);
  const m = st.matrix as Affine;

  if (st.mode === "warp" || st.mode === "distort") {
    const mode: "warp" | "distort" = st.mode;
    const pts = mode === "warp" ? st.mesh : st.corners;
    return (
      <svg className={`${ed.shapes} ${ed.handles}`} aria-hidden="false" data-testid="transform-handles" data-mode={st.mode}>
        {st.mode === "distort" ? <polygon className={ed.solidLine} points={pts.map((p) => `${toS(p).x},${toS(p).y}`).join(" ")} /> : null}
        {st.mode === "warp"
          ? [0, 1, 2, 3].map((r) => <polyline key={`r${r}`} className={ed.solidLine} points={[0, 1, 2, 3].map((c) => `${toS(pts[r * 4 + c] as Point).x},${toS(pts[r * 4 + c] as Point).y}`).join(" ")} />)
          : null}
        {st.mode === "warp"
          ? [0, 1, 2, 3].map((c) => <polyline key={`c${c}`} className={ed.solidLine} points={[0, 1, 2, 3].map((r) => `${toS(pts[r * 4 + c] as Point).x},${toS(pts[r * 4 + c] as Point).y}`).join(" ")} />)
          : null}
        {pts.map((p, i) => (
          <PointHandle key={i} engine={engine} index={i} at={toS(p)} mode={mode} />
        ))}
      </svg>
    );
  }

  const corners = HANDLES.filter((h) => h.hx !== 0.5 && h.hy !== 0.5);
  const outline = [corners[0], corners[1], corners[2], corners[3]].map((h) => toS(handlePoint(m, st.rect, h as HandleId)));
  const top = toS(handlePoint(m, st.rect, { hx: 0.5, hy: 0 }));
  const centre = toS(centreOf(m, st.rect));
  // The rotate handle sits ROTATE_GAP px beyond the top edge, away from the centre.
  const dx = top.x - centre.x;
  const dy = top.y - centre.y;
  const len = Math.hypot(dx, dy) || 1;
  const rot = { x: top.x + (dx / len) * ROTATE_GAP, y: top.y + (dy / len) * ROTATE_GAP };
  return (
    <svg className={`${ed.shapes} ${ed.handles}`} data-testid="transform-handles" data-mode={st.mode}>
      <polygon className={ed.solidLine} points={outline.map((p) => `${p.x},${p.y}`).join(" ")} />
      <line className={ed.solidLine} x1={top.x} y1={top.y} x2={rot.x} y2={rot.y} />
      {HANDLES.map((h, i) => (
        <ScaleHandle key={i} engine={engine} h={h} at={toS(handlePoint(m, st.rect, h))} uniform={st.mode === "uniform"} />
      ))}
      <RotateHandle engine={engine} at={rot} />
    </svg>
  );
}

function ScaleHandle({ engine, h, at, uniform }: { engine: PaintEngine; h: HandleId; at: Point; uniform: boolean }) {
  const drag = useHandleDrag(
    engine,
    () => undefined,
    (p, ev) => {
      const st = (engine as Ext).transformState?.();
      if (!st) return;
      engine.transform.set({ matrix: scaleHandle(st.matrix, st.rect, h, p, uniform || ev.shiftKey) });
    },
  );
  return <Dot s={at} label={`Scale from the ${h.hy === 0 ? "top" : h.hy === 1 ? "bottom" : ""}${h.hx === 0 ? " left" : h.hx === 1 ? " right" : ""}`.trim()} drag={drag} />;
}

function RotateHandle({ engine, at }: { engine: PaintEngine; at: Point }) {
  const start = useRef<{ m: Affine; at: Point } | null>(null);
  const drag = useHandleDrag(
    engine,
    (p) => {
      const st = (engine as Ext).transformState?.();
      if (st) start.current = { m: st.matrix as Affine, at: p };
    },
    (p, ev) => {
      const st = (engine as Ext).transformState?.();
      const s = start.current;
      if (!st || !s) return;
      engine.transform.set({ matrix: rotateDrag(s.m, st.rect, s.at, p, ev.shiftKey) });
    },
    () => {
      start.current = null;
    },
  );
  return <Dot s={at} kind="rot" label="Rotate" drag={drag} />;
}

function PointHandle({ engine, index, at, mode }: { engine: PaintEngine; index: number; at: Point; mode: "warp" | "distort" }) {
  const drag = useHandleDrag(
    engine,
    () => undefined,
    (p) => {
      const st = (engine as Ext).transformState?.();
      if (!st) return;
      if (mode === "warp") engine.transform.set({ mesh: movePoint(st.mesh, index, p) });
      else engine.transform.set({ corners: movePoint(st.corners, index, p) });
    },
  );
  return <Dot s={at} kind={mode === "warp" ? "mesh" : undefined} label={mode === "warp" ? `Mesh point ${index + 1}` : `Corner ${index + 1}`} drag={drag} />;
}

/** QuickShape: the snapped shape's handles. Dragging one re-strokes the shape. */
export function QuickShapeHandles({ engine, shape, onChange, onDone }: { engine: PaintEngine; shape: Shape; onChange(s: Shape): void; onDone(): void }) {
  useEngineEvents(engine, ["view"]);
  const pts = shapeHandles(shape);
  return (
    <svg className={`${ed.shapes} ${ed.handles}`} data-testid="quickshape-handles" data-shape={shape.kind}>
      {pts.map((p, i) => (
        <QuickHandle key={i} engine={engine} index={i} at={engine.view.canvasToScreen(p)} shape={shape} onChange={onChange} onDone={onDone} />
      ))}
    </svg>
  );
}

function QuickHandle({ engine, index, at, shape, onChange, onDone }: { engine: PaintEngine; index: number; at: Point; shape: Shape; onChange(s: Shape): void; onDone(): void }) {
  const cur = useRef(shape);
  cur.current = shape;
  const drag = useHandleDrag(
    engine,
    () => undefined,
    (p) => onChange(moveHandle(cur.current, index, p)),
    onDone,
  );
  return <Dot s={at} label={`Shape handle ${index + 1}`} drag={drag} />;
}
