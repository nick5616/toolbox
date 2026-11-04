/**
 * Handles of the selected mask on the preview (§14.8): rect/ellipse get a body
 * (move) and four corners (resize around the centre); a path gets draggable
 * points, a double-click on an edge adds a point, Alt-click on a point removes
 * it. Keyed params get a key at the playhead; one undo step per drag.
 */
import { useRef, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { MAX_PATH_POINTS, parseMasks, serializeMasks } from "@/viz/edit/schema";
import type { EditParam, Mask } from "@/viz/edit/types";
import { currentClip, patchClip } from "../inspector/inspectorState";
import { MASK_RANGES } from "../inspector/MasksSection";
import { valueAt, writeValue } from "../inspector/paramOps";
import {
  boxToCanvas,
  boxToMaskLocal,
  canvasToBox,
  maskCentreFromDrag,
  maskCorners,
  maskLocalToBox,
  maskSizeFromCorner,
  nearestEdge,
  type Box,
  type MaskValues,
  type Pt,
} from "./overlayGeometry";
import type { OverlayCtx } from "./overlayContext";
import styles from "./overlays.module.css";

const HANDLE_PX = 6;
/** A double-click must land this close (CSS px) to an edge to add a point. */
const EDGE_HIT_PX = 10;

type Kind = { t: "move" } | { t: "corner" } | { t: "point"; i: number };
interface Drag {
  kind: Kind;
  pointerId: number;
  start: Pt;
  values: MaskValues;
  box: Box;
  clipMs: number;
  key: string;
}
let dragSeq = 0;

const maskValues = (m: Mask, clipMs: number): MaskValues => ({
  x: valueAt(m.x, MASK_RANGES.x.min, MASK_RANGES.x.max, clipMs),
  y: valueAt(m.y, MASK_RANGES.y.min, MASK_RANGES.y.max, clipMs),
  w: valueAt(m.w, MASK_RANGES.w.min, MASK_RANGES.w.max, clipMs),
  h: valueAt(m.h, MASK_RANGES.h.min, MASK_RANGES.h.max, clipMs),
  rotation: valueAt(m.rotation, MASK_RANGES.rotation.min, MASK_RANGES.rotation.max, clipMs),
});

/** Rewrites one mask of a clip through the store. */
function updateMask(clipId: string, maskId: string, fn: (m: Mask) => Mask, key: string): void {
  const cur = currentClip(clipId);
  if (!cur) return;
  const masks = parseMasks(cur.masks).value;
  patchClip(clipId, { masks: serializeMasks(masks.map((m) => (m.id === maskId ? fn(m) : m))) }, key);
}

export function MaskHandles({ ctx, mask }: { ctx: OverlayCtx; mask: Mask }) {
  const { clip, box, k } = ctx;
  const drag = useRef<Drag | null>(null);
  const v = maskValues(mask, ctx.clipMs);
  const r = HANDLE_PX * k;
  const bw = box.w;
  const bh = box.h;

  const begin = (kind: Kind) => (e: RPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (kind.t === "point" && e.altKey) {
      removePoint(kind.i);
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { kind, pointerId: e.pointerId, start: ctx.toCanvas(e), values: v, box, clipMs: ctx.clipMs, key: `ov:mask:${mask.id}:${++dragSeq}` };
  };

  const removePoint = (i: number) => {
    if (!mask.points || mask.points.length <= 3) return;
    updateMask(clip.id, mask.id, (m) => ({ ...m, points: (m.points ?? []).filter((_, k) => k !== i) }), "");
  };

  const move = (e: RPointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = ctx.toCanvas(e);
    const set = (m: Mask, name: "x" | "y" | "w" | "h", val: number): EditParam => writeValue(m[name], val, MASK_RANGES[name].min, MASK_RANGES[name].max, d.clipMs);
    if (d.kind.t === "move") {
      const c = maskCentreFromDrag({ x: d.values.x, y: d.values.y }, d.box, { x: p.x - d.start.x, y: p.y - d.start.y });
      updateMask(clip.id, mask.id, (m) => ({ ...m, x: set(m, "x", c.x), y: set(m, "y", c.y) }), d.key);
    } else if (d.kind.t === "corner") {
      const s = maskSizeFromCorner(d.values, d.box, p);
      updateMask(clip.id, mask.id, (m) => ({ ...m, w: set(m, "w", s.w), h: set(m, "h", s.h) }), d.key);
    } else {
      const i = d.kind.i;
      const local = boxToMaskLocal(d.values, d.box, canvasToBox(d.box, p));
      updateMask(clip.id, mask.id, (m) => ({ ...m, points: (m.points ?? []).map((pt, n): [number, number] => (n === i ? [local.x, local.y] : pt)) }), d.key);
    }
  };

  const end = (e: RPointerEvent<SVGElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    drag.current = null;
  };

  const handlers = (kind: Kind) => ({ onPointerDown: begin(kind), onPointerMove: move, onPointerUp: end, onPointerCancel: end });
  const outline = [boxToCanvas(box, { x: 0, y: 0 }), boxToCanvas(box, { x: bw, y: 0 }), boxToCanvas(box, { x: bw, y: bh }), boxToCanvas(box, { x: 0, y: bh })];
  const outlinePts = outline.map((p) => `${p.x},${p.y}`).join(" ");

  let body: ReactNode;
  if (mask.shape === "path") {
    const pts = (mask.points ?? []).map((p) => boxToCanvas(box, maskLocalToBox(v, box, { x: p[0], y: p[1] })));
    const polyPts = pts.map((p) => `${p.x},${p.y}`).join(" ");
    const addPoint = (e: RMouseEvent<SVGElement>) => {
      if (pts.length >= MAX_PATH_POINTS) return;
      const p = ctx.toCanvas(e);
      const hit = nearestEdge(pts, p);
      if (!hit || hit.distance > EDGE_HIT_PX * k) return;
      const local = boxToMaskLocal(v, box, canvasToBox(box, hit.point));
      updateMask(
        clip.id,
        mask.id,
        (m) => {
          const list = (m.points ?? []).slice();
          list.splice(hit.index + 1, 0, [local.x, local.y]);
          return { ...m, points: list };
        },
        "",
      );
    };
    body = (
      <>
        <polygon data-testid="mask-body" className={styles.maskShape} points={polyPts} data-tip="Drag to move the whole mask shape" {...handlers({ t: "move" })} />
        <polygon data-testid="mask-edges" className={styles.edgeHit} points={polyPts} data-tip="Double-click an edge to add a point to the mask" onDoubleClick={addPoint} />
        {pts.map((p, i) => (
          <circle key={i} data-testid={`mask-point-${i}`} aria-label={`Mask point ${i + 1}`} data-tip="Drag to reshape the mask; Alt+click removes the point (a mask keeps at least 3)" className={`${styles.handle} ${styles.pointHandle}`} cx={p.x} cy={p.y} r={r} {...handlers({ t: "point", i })} />
        ))}
      </>
    );
  } else {
    const corners = maskCorners(v, box);
    const c = boxToCanvas(box, { x: v.x * bw, y: v.y * bh });
    const shape =
      mask.shape === "ellipse" ? (
        <ellipse
          data-testid="mask-body"
          className={styles.maskShape}
          cx={c.x}
          cy={c.y}
          rx={Math.max(0.5, (v.w * bw) / 2)}
          ry={Math.max(0.5, (v.h * bh) / 2)}
          transform={`rotate(${box.rotation + v.rotation} ${c.x} ${c.y})`}
          data-tip="Drag to move the mask"
          {...handlers({ t: "move" })}
        />
      ) : (
        <polygon data-testid="mask-body" className={styles.maskShape} points={corners.map((p) => `${p.x},${p.y}`).join(" ")} data-tip="Drag to move the mask" {...handlers({ t: "move" })} />
      );
    body = (
      <>
        {shape}
        {corners.map((p, i) => (
          <circle key={i} data-testid={`mask-corner-${i}`} aria-label={`Resize mask, corner ${i + 1}`} data-tip="Drag to resize the mask around its centre" className={`${styles.handle} ${styles.cornerHandle}`} cx={p.x} cy={p.y} r={r} {...handlers({ t: "corner" })} />
        ))}
      </>
    );
  }

  return (
    <g data-testid="mask-handles" role="group" aria-label="Mask handles">
      <polygon className={styles.outline} points={outlinePts} />
      {body}
    </g>
  );
}
