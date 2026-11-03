/**
 * The selected clip's transform box on the preview (§14.8): drag the body to
 * move (snapping to the centre lines), the corners scale uniformly, the top
 * handle rotates. Writes keys at the playhead when a param is keyed, else the
 * base; one undo step per drag (Alt turns snapping off).
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { parseTransform, serializeTransform, TRANSFORM_RULES } from "@/viz/edit/schema";
import type { ClipTransform } from "@/viz/edit/types";
import { currentClip, patchClip } from "../inspector/inspectorState";
import { writeValue } from "../inspector/paramOps";
import { CORNERS, cornerPoint, rotateHandle, rotationFromDrag, scaleFromDrag, snapCentre, visibleBox, type Box, type Pt, type TransformValues } from "./overlayGeometry";
import type { OverlayCtx } from "./overlayContext";
import styles from "./overlays.module.css";

/** Snap distance to a centre line, as a fraction of the frame. */
export const CENTRE_SNAP = 0.012;
const HANDLE_PX = 6;
const ROTATE_STEM_PX = 26;

type Kind = "move" | "scale" | "rotate";
interface Drag {
  kind: Kind;
  pointerId: number;
  start: Pt;
  values: TransformValues;
  box: Box;
  clipMs: number;
  key: string;
}

let dragSeq = 0;

export function TransformBox({ ctx }: { ctx: OverlayCtx }) {
  const { clip, frame, box, k } = ctx;
  const drag = useRef<Drag | null>(null);
  const [guide, setGuide] = useState({ x: false, y: false });

  const begin = (kind: Kind) => (e: RPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { kind, pointerId: e.pointerId, start: ctx.toCanvas(e), values: ctx.values, box, clipMs: Math.round(ctx.clipMs), key: `ov:${clip.id}:${++dragSeq}` };
  };

  const move = (e: RPointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = ctx.toCanvas(e);
    const next: Partial<TransformValues> = {};
    const g = { x: false, y: false };
    if (d.kind === "move") {
      let x = d.values.x + (p.x - d.start.x) / frame.w;
      let y = d.values.y + (p.y - d.start.y) / frame.h;
      if (!e.altKey) {
        const sx = snapCentre(x, CENTRE_SNAP);
        const sy = snapCentre(y, CENTRE_SNAP);
        x = sx.value;
        y = sy.value;
        g.x = sx.snapped;
        g.y = sy.snapped;
      }
      next.x = x;
      next.y = y;
    } else if (d.kind === "scale") {
      next.scale = scaleFromDrag(d.values.scale, { x: d.box.cx, y: d.box.cy }, d.start, p, TRANSFORM_RULES.scale.min, TRANSFORM_RULES.scale.max);
    } else {
      next.rotation = rotationFromDrag(d.values.rotation, { x: d.box.cx, y: d.box.cy }, d.start, p, !e.altKey);
    }
    setGuide(g);
    const cur = currentClip(clip.id);
    if (!cur) return;
    const t: ClipTransform = { ...parseTransform(cur.transform).value };
    for (const name of Object.keys(next) as Array<keyof TransformValues>) {
      const r = TRANSFORM_RULES[name];
      t[name] = writeValue(t[name], next[name] as number, r.min, r.max, d.clipMs);
    }
    patchClip(clip.id, { transform: serializeTransform(t) }, d.key);
  };

  const end = (e: RPointerEvent<SVGElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setGuide({ x: false, y: false });
  };

  const handlers = (kind: Kind) => ({ onPointerDown: begin(kind), onPointerMove: move, onPointerUp: end, onPointerCancel: end });
  // Handles sit on the part of the clip inside the frame; scaling and rotating
  // still pivot on the clip's own centre (the drag keeps the full box).
  const shown = visibleBox(box, frame);
  const corners = CORNERS.map((c) => ({ id: c, p: cornerPoint(shown, c) }));
  const poly = corners.map((c) => `${c.p.x},${c.p.y}`).join(" ");
  const rot = rotateHandle(shown, ROTATE_STEM_PX * k);
  const r = HANDLE_PX * k;

  return (
    <g data-testid="transform-box" role="group" aria-label="Transform box">
      {guide.x && <line className={styles.guide} x1={frame.w / 2} x2={frame.w / 2} y1={0} y2={frame.h} />}
      {guide.y && <line className={styles.guide} x1={0} x2={frame.w} y1={frame.h / 2} y2={frame.h / 2} />}
      <polygon data-testid="transform-body" className={styles.body} points={poly} {...handlers("move")} />
      <line className={styles.stem} x1={rot.from.x} y1={rot.from.y} x2={rot.to.x} y2={rot.to.y} />
      <circle data-testid="handle-rotate" aria-label="Rotate" className={`${styles.handle} ${styles.rotateHandle}`} cx={rot.to.x} cy={rot.to.y} r={r} {...handlers("rotate")} />
      {corners.map((c) => (
        <circle key={c.id} data-testid={`handle-${c.id}`} aria-label={`Scale from ${c.id} corner`} className={`${styles.handle} ${styles.cornerHandle}`} cx={c.p.x} cy={c.p.y} r={r} {...handlers("scale")} />
      ))}
    </g>
  );
}
