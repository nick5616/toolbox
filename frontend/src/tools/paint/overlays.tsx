/** Canvas overlays: pending perception regions, the marquee/lasso, the brush HUD. */
import { useMemo } from "react";
import { PaintIcon } from "./ui";
import { useEditor, useEngineEvents, useQueueVersion } from "./context";
import type { OverlayShape } from "./canvasInput";
import { usePaintUI } from "./store";
import ed from "./editor.module.css";

/** Pending regions shimmer with a cancel ×; a failed one turns red (SPEC §1.4.2, §4). */
export function PendingRegions() {
  const { engine, queue } = useEditor();
  useEngineEvents(engine, ["view"]);
  useQueueVersion(queue);
  return (
    <>
      {queue.pending().map((p) => {
        const a = engine.view.canvasToScreen({ x: p.bounds.x, y: p.bounds.y });
        const b = engine.view.canvasToScreen({ x: p.bounds.x + p.bounds.w, y: p.bounds.y + p.bounds.h });
        const failed = p.state === "failed";
        return (
          <div
            key={p.id}
            className={failed ? ed.pendingFailed : ed.pending}
            style={{ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }}
            role="status"
            aria-label={failed ? "That fill failed" : `Working on a region (${Math.round(p.progress * 100)}%)`}
            data-testid="pending-region"
            data-state={p.state}
          >
            <span className={ed.pendingLabel}>{failed ? "That fill failed — try again" : p.message || "Working"}</span>
            <button type="button" className={ed.pendingX} aria-label={failed ? "Dismiss" : "Cancel this region"} data-tip={failed ? "Dismiss" : "Cancel this region"} onClick={() => queue.cancel(p.id)}>
              <PaintIcon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </>
  );
}

/** The selection marquee, lasso path or Select-object points while the pointer is down. */
export function ShapeOverlay({ shape }: { shape: OverlayShape | null }) {
  const { engine } = useEditor();
  useEngineEvents(engine, ["view", "selection"]);
  const sel = engine.selection.bounds();
  const toS = (x: number, y: number) => engine.view.canvasToScreen({ x, y });
  const rectEl = (r: { x: number; y: number; w: number; h: number }, ellipse: boolean, dashed = true) => {
    const a = toS(r.x, r.y);
    const b = toS(r.x + r.w, r.y + r.h);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    return ellipse ? <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} className={dashed ? ed.marching : ed.solidLine} /> : <rect x={x} y={y} width={w} height={h} className={dashed ? ed.marching : ed.solidLine} />;
  };
  return (
    <svg className={ed.shapes} aria-hidden="true">
      {sel ? rectEl(sel, false) : null}
      {shape && shape.kind !== "lasso" && shape.kind !== "points" ? rectEl(shape.rect, shape.kind === "ellipse") : null}
      {shape && shape.kind === "lasso" ? (
        <polyline className={ed.marching} fill="none" points={shape.points.map((p) => `${toS(p.x, p.y).x},${toS(p.x, p.y).y}`).join(" ")} />
      ) : null}
      {shape && shape.kind === "points"
        ? shape.points.map((p, i) => {
            const s = toS(p.x, p.y);
            return <circle key={i} cx={s.x} cy={s.y} r="6" className={p.positive ? ed.pointPos : ed.pointNeg} />;
          })
        : null}
    </svg>
  );
}

/** A Select-object preview mask (white, alpha = mask) as a tinted data URL. */
function tintedURL(mask: ImageData): string {
  if (typeof document === "undefined") return "";
  const c = document.createElement("canvas");
  c.width = mask.width;
  c.height = mask.height;
  const g = c.getContext("2d");
  if (!g) return "";
  const out = new Uint8ClampedArray(mask.data.length);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 70;
    out[i + 1] = 140;
    out[i + 2] = 255;
    out[i + 3] = mask.data[i + 3] as number;
  }
  g.putImageData(new ImageData(out, mask.width, mask.height), 0, 0);
  return c.toDataURL("image/png");
}

/** The live Select-object mask, laid over the canvas with the view's transform (zoom, pan, rotation, flip). */
export function MaskPreview({ mask }: { mask: ImageData | null }) {
  const { engine } = useEditor();
  useEngineEvents(engine, ["view"]);
  const url = useMemo(() => (mask ? tintedURL(mask) : ""), [mask]);
  if (!mask || !url) return null;
  const o = engine.view.canvasToScreen({ x: 0, y: 0 });
  const ux = engine.view.canvasToScreen({ x: 1, y: 0 });
  const uy = engine.view.canvasToScreen({ x: 0, y: 1 });
  const sx = engine.doc.width / mask.width;
  const sy = engine.doc.height / mask.height;
  const m = [ux.x - o.x, ux.y - o.y, uy.x - o.x, uy.y - o.y, o.x, o.y];
  return (
    <svg className={ed.shapes} aria-hidden="true" data-testid="mask-preview">
      <image href={url} width={mask.width} height={mask.height} opacity={0.55} transform={`matrix(${m.join(" ")}) scale(${sx} ${sy})`} />
    </svg>
  );
}

/** The HUD shown while `[` / `]` are held: size, opacity and the brush name. */
export function BrushHud({ at }: { at: { x: number; y: number } | null }) {
  const hud = usePaintUI((s) => s.hud);
  const size = usePaintUI((s) => s.size);
  const opacity = usePaintUI((s) => s.opacity);
  const tool = usePaintUI((s) => s.tool);
  const brush = usePaintUI((s) => (s.tool === "smudge" ? s.brushes.smudge : s.tool === "eraser" ? s.brushes.eraser : s.brushes.brush));
  if (!hud) return null;
  return (
    <div className={ed.hud} style={at ? { left: at.x + 24, top: at.y + 24 } : { left: "50%", top: "50%" }} role="status" data-testid="brush-hud">
      <strong>{brush?.name ?? tool}</strong>
      <span>
        {size} px · {Math.round(opacity * 100)}%
      </span>
    </div>
  );
}
