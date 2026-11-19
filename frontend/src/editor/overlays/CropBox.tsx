/**
 * Crop handles on the preview (Phase 21 SPEC §B4): the kept rectangle with a
 * handle on each edge. Dragging writes the crop (a key at the playhead when the
 * edge is keyed, else its base); one undo step per drag.
 */
import { useRef, type PointerEvent as RPointerEvent } from "react";
import { parseTransform, serializeTransform, CROP_RULES } from "@/viz/edit/schema";
import type { ClipCrop } from "@/viz/edit/types";
import { currentClip, patchClip } from "../inspector/inspectorState";
import { writeValue } from "../inspector/paramOps";
import { cropCorners, cropEdgeFromPoint, cropHandlePoint, type CropEdge, type CropValues } from "./cropGeometry";
import { cropAt, type OverlayCtx } from "./overlayContext";
import styles from "./overlays.module.css";

const EDGES: Array<{ id: CropEdge; label: string }> = [
  { id: "l", label: "left" },
  { id: "r", label: "right" },
  { id: "t", label: "top" },
  { id: "b", label: "bottom" },
];
const HANDLE_PX = 6;

/** Writes crop edges into a clip's transform (keys at clipMs where an edge is keyed); all-zero crop is removed. */
export function writeCrop(clipId: string, edges: Partial<CropValues>, clipMs: number, key: string): void {
  const cur = currentClip(clipId);
  if (!cur) return;
  const t = parseTransform(cur.transform).value;
  const crop: ClipCrop = { ...(t.crop ?? { l: 0, r: 0, t: 0, b: 0 }) };
  for (const e of Object.keys(edges) as CropEdge[]) crop[e] = writeValue(crop[e], edges[e] as number, CROP_RULES.min, CROP_RULES.max, clipMs);
  const empty = (["l", "r", "t", "b"] as const).every((k) => crop[k] === 0);
  patchClip(clipId, { transform: serializeTransform({ ...t, crop: empty ? undefined : crop }) }, key);
}

let dragSeq = 0;

export function CropBox({ ctx }: { ctx: OverlayCtx }) {
  const { clip, box, k, frame } = ctx;
  const drag = useRef<{ edge: CropEdge; pointerId: number; clipMs: number; key: string } | null>(null);
  const c = cropAt(clip.transform, ctx.clipMs);
  const crop: CropValues = { l: c[0], r: c[1], t: c[2], b: c[3] };

  const down = (edge: CropEdge) => (e: RPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { edge, pointerId: e.pointerId, clipMs: Math.round(ctx.clipMs), key: `crop:${clip.id}:${++dragSeq}` };
  };
  const move = (e: RPointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    writeCrop(clip.id, { [d.edge]: cropEdgeFromPoint(box, ctx.toCanvas(e), d.edge) }, d.clipMs, d.key);
  };
  const up = (e: RPointerEvent<SVGElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    drag.current = null;
  };

  const poly = cropCorners(box, crop)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
  const r = HANDLE_PX * k;
  return (
    <g data-testid="crop-box" role="group" aria-label="Crop handles">
      <polygon className={styles.outline} points={poly} />
      {EDGES.map((e) => {
        const p = cropHandlePoint(box, crop, e.id, frame, r * 1.5);
        return (
          <rect
            key={e.id}
            data-testid={`crop-handle-${e.id}`}
            aria-label={`Crop ${e.label} edge`}
            data-tip={`Drag to crop the ${e.label} edge of the picture`}
            className={`${styles.handle} ${styles.cropHandle}`}
            x={p.x - r}
            y={p.y - r}
            width={2 * r}
            height={2 * r}
            onPointerDown={down(e.id)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        );
      })}
    </g>
  );
}
