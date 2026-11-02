import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { Spinner } from "@/components";
import type { ComposerLayer, Composition } from "@/lib/api";
import { boxCorners, hitHandle, hitLayer, handlePositions, layerBox, type Box, type Guide, type Handle, type Point } from "@/composer/hittest";
import { imageSize, layerSize, renderComposition, textFont } from "@/composer/render";
import { findLayer, updateLayer } from "@/composer/model";
import { useSourceDropTarget, type SourceDropInfo } from "../post-builder/sourceDrag";
import { canvasFraction, fitScale, handleGeometry, moveWithSnap, panBackground, pointsOf, rotateByHandle, scaleByHandle, SNAP_SCREEN_PX, zoomBackground } from "./logic";
import styles from "./Stage.module.css";

export interface StageProps {
  doc: Composition;
  images: ReadonlyMap<string, ImageBitmap>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Shows doc without recording it (during a drag); null ends the preview. */
  onLive: (doc: Composition | null) => void;
  /** Records a finished edit. */
  onCommit: (doc: Composition, opts?: { merge?: boolean }) => void;
  editingId: string | null;
  onEditing: (id: string | null) => void;
  onTextChange: (id: string, text: string) => void;
  adjustBg: boolean;
  /** Layers waiting for a job (a spinner is drawn on them). */
  busyIds: ReadonlySet<string>;
  zoom: number;
  onZoom: (z: number) => void;
  /** Post sources dropped on the canvas, at fractions (0..1) of its width and height. */
  onSourceDrop?: (paths: string[], x: number, y: number) => void;
}

type Mode = "move" | "scale" | "rotate" | "bg";

interface Session {
  mode: Mode;
  startP: Point;
  startDoc: Composition;
  layerId: string;
  startBox: Box | null;
  handle: Handle | null;
  moved: boolean;
  last: Composition | null;
}

const MIN_DRAG_SCREEN_PX = 3;

function cursorFor(handle: Handle | null, overLayer: boolean, adjustBg: boolean): string {
  if (handle === "rotate") return "grab";
  if (handle === "nw" || handle === "se") return "nwse-resize";
  if (handle === "ne" || handle === "sw") return "nesw-resize";
  if (adjustBg) return "grab";
  return overLayer ? "move" : "default";
}

/** The canvas, the selection overlay and every pointer interaction on the artwork. */
export function Stage(props: StageProps) {
  const { doc, images, selectedId, adjustBg, busyIds, zoom, editingId } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState({ w: 900, h: 640 });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [cursor, setCursor] = useState("default");
  const session = useRef<Session | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const fit = fitScale(avail.w, avail.h, doc.width, doc.height);
  const scale = fit * zoom;
  const cssW = Math.round(doc.width * scale);
  const cssH = Math.round(doc.height * scale);

  const onSourceDrop = props.onSourceDrop;
  const dropped = useCallback(
    (info: SourceDropInfo) => {
      const r = wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
      const p = canvasFraction(info.x, info.y, r);
      onSourceDrop?.(info.paths, p.x, p.y);
    },
    [onSourceDrop],
  );
  useSourceDropTarget(wrapRef, dropped);

  // Fit the available area.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setAvail({ w: r.width, h: r.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sizer = useCallback((l: ComposerLayer) => layerSize(doc, l, images), [doc, images]);

  // Redraw on the next frame, only when something changed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const raf = requestAnimationFrame(() => {
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      renderComposition(ctx, doc, images, { scale: (cssW / doc.width) * dpr, editor: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [doc, images, cssW, cssH, dpr]);

  // Wheel: Ctrl/Cmd zooms the stage; in "Adjust background" it zooms the photo.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const p = propsRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        p.onZoom(Math.min(4, Math.max(1, p.zoom * Math.exp(-e.deltaY * 0.002))));
      } else if (p.adjustBg && p.doc.background.kind === "image") {
        e.preventDefault();
        const z = zoomBackground(p.doc.background.zoom || 1, e.deltaY);
        p.onCommit({ ...p.doc, background: { ...p.doc.background, zoom: z } }, { merge: true });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const toDoc = (e: { clientX: number; clientY: number }): Point => {
    const r = wrapRef.current?.getBoundingClientRect();
    const s = scale > 0 ? scale : 1;
    return { x: (e.clientX - (r?.left ?? 0)) / s, y: (e.clientY - (r?.top ?? 0)) / s };
  };

  const selected = selectedId ? findLayer(doc, selectedId) : undefined;

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editingId) return;
    if ((e.target as HTMLElement).closest("[data-stage-ui]")) return;
    const p = toDoc(e);
    wrapRef.current?.focus();
    let s: Session | null = null;
    if (adjustBg && doc.background.kind === "image") {
      s = { mode: "bg", startP: p, startDoc: doc, layerId: "", startBox: null, handle: null, moved: false, last: null };
    } else {
      if (selected && !selected.locked && !selected.hidden) {
        const box = layerBox(doc, selected, sizer);
        const h = hitHandle(box, p, handleGeometry(scale));
        if (h) {
          s = { mode: h === "rotate" ? "rotate" : "scale", startP: p, startDoc: doc, layerId: selected.id, startBox: box, handle: h, moved: false, last: null };
        }
      }
      if (!s) {
        const hit = hitLayer(doc, p, sizer);
        if (hit) {
          props.onSelect(hit.id);
          s = { mode: "move", startP: p, startDoc: doc, layerId: hit.id, startBox: layerBox(doc, hit, sizer), handle: null, moved: false, last: null };
        } else {
          props.onSelect(null);
        }
      }
    }
    if (s) {
      session.current = s;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = toDoc(e);
    const s = session.current;
    if (!s) {
      if (editingId) return;
      let handle: Handle | null = null;
      if (selected && !selected.locked && !selected.hidden) handle = hitHandle(layerBox(doc, selected, sizer), p, handleGeometry(scale));
      const c = cursorFor(handle, !!hitLayer(doc, p, sizer), adjustBg && doc.background.kind === "image");
      if (c !== cursor) setCursor(c);
      return;
    }
    const dx = p.x - s.startP.x;
    const dy = p.y - s.startP.y;
    if (!s.moved) {
      if (Math.hypot(dx, dy) * scale < MIN_DRAG_SCREEN_PX) return;
      s.moved = true;
    }
    const sd = s.startDoc;
    const startSizer = (l: ComposerLayer) => layerSize(sd, l, images);
    const layer = s.layerId ? findLayer(sd, s.layerId) : undefined;
    let next: Composition | null = null;
    if (s.mode === "move" && layer && s.startBox && !layer.locked) {
      const r = moveWithSnap(sd, layer, s.startBox, dx, dy, startSizer, SNAP_SCREEN_PX / scale, !e.ctrlKey && !e.metaKey);
      next = updateLayer(sd, layer.id, r.patch);
      setGuides(r.guides);
    } else if (s.mode === "scale" && layer && s.startBox && s.handle && s.handle !== "rotate") {
      next = updateLayer(sd, layer.id, scaleByHandle(sd, layer, s.startBox, s.handle, p, e.altKey));
    } else if (s.mode === "rotate" && layer && s.startBox) {
      next = updateLayer(sd, layer.id, { rotation: rotateByHandle(s.startBox, p, e.shiftKey) });
    } else if (s.mode === "bg") {
      const path = sd.background.image?.path;
      const bmp = path ? images.get(path) : undefined;
      if (bmp) {
        const pan = panBackground(sd, imageSize(bmp), { panX: sd.background.panX, panY: sd.background.panY }, dx, dy);
        next = { ...sd, background: { ...sd.background, ...pan } };
      }
    }
    if (next) {
      s.last = next;
      props.onLive(next);
    }
  };

  const endDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setGuides([]);
    if (s.last) {
      props.onCommit(s.last);
    }
    props.onLive(null);
  };

  const onDoubleClick = (e: RMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-stage-ui]")) return;
    const hit = hitLayer(doc, toDoc(e), sizer);
    if (hit?.kind === "text" && !hit.locked) {
      props.onSelect(hit.id);
      props.onEditing(hit.id);
    }
  };

  const overlay = useMemo(() => {
    if (!selected || selected.hidden) return null;
    const box = layerBox(doc, selected, sizer);
    return { box, corners: boxCorners(box), handles: handlePositions(box, handleGeometry(scale)) };
  }, [selected, doc, sizer, scale]);

  const hr = 5 / scale;
  const editing = editingId ? findLayer(doc, editingId) : undefined;

  return (
    <div ref={viewportRef} className={styles.viewport}>
      <div
        ref={wrapRef}
        className={styles.stage}
        style={{ width: cssW, height: cssH, cursor }}
        tabIndex={0}
        data-testid="composer-stage"
        aria-label="Canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        <canvas ref={canvasRef} className={styles.canvas} style={{ width: cssW, height: cssH }} />
        <svg className={styles.overlay} width={cssW} height={cssH} viewBox={`0 0 ${doc.width} ${doc.height}`} aria-hidden="true">
          {guides.map((g, i) =>
            g.axis === "x" ? (
              <line key={i} className={styles.guide} x1={g.pos} x2={g.pos} y1={g.from} y2={g.to} vectorEffect="non-scaling-stroke" />
            ) : (
              <line key={i} className={styles.guide} y1={g.pos} y2={g.pos} x1={g.from} x2={g.to} vectorEffect="non-scaling-stroke" />
            ),
          )}
          {overlay && (
            <>
              <polygon
                className={selected?.locked ? styles.boxLocked : styles.box}
                points={pointsOf(overlay.corners)}
                vectorEffect="non-scaling-stroke"
              />
              {!selected?.locked && !editing && (
                <>
                  <line
                    className={styles.stem}
                    x1={(overlay.corners[0].x + overlay.corners[1].x) / 2}
                    y1={(overlay.corners[0].y + overlay.corners[1].y) / 2}
                    x2={overlay.handles.rotate.x}
                    y2={overlay.handles.rotate.y}
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle className={styles.handle} cx={overlay.handles.rotate.x} cy={overlay.handles.rotate.y} r={hr} vectorEffect="non-scaling-stroke" />
                  {(["nw", "ne", "se", "sw"] as const).map((h) => (
                    <rect
                      key={h}
                      className={styles.handle}
                      x={overlay.handles[h].x - hr}
                      y={overlay.handles[h].y - hr}
                      width={hr * 2}
                      height={hr * 2}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </>
              )}
            </>
          )}
        </svg>
        {[...busyIds].map((id) => {
          const l = findLayer(doc, id);
          if (!l) return null;
          const box = layerBox(doc, l, sizer);
          return (
            <span key={id} data-stage-ui>
              <span
                className={styles.shimmer}
                data-testid="cutting-shimmer"
                style={{
                  left: (box.cx - box.w / 2) * scale,
                  top: (box.cy - box.h / 2) * scale,
                  width: box.w * scale,
                  height: box.h * scale,
                  transform: `rotate(${l.rotation}deg)`,
                }}
              />
              <span className={styles.busy} data-stage-ui style={{ left: l.x * doc.width * scale, top: l.y * doc.height * scale }}>
                <Spinner size={22} label="Removing background" />
              </span>
            </span>
          );
        })}
        {editing?.text && (
          <textarea
            data-stage-ui
            className={styles.editor}
            aria-label="Edit text"
            autoFocus
            value={editing.text.text}
            style={{
              left: editing.x * doc.width * scale,
              top: editing.y * doc.height * scale,
              minWidth: Math.max(80, layerBox(doc, editing, sizer).w * scale + 16),
              font: textFont(editing, Math.max(8, editing.size * doc.width * scale)),
              lineHeight: editing.text.lineHeight,
              color: editing.text.color,
              textAlign: editing.text.align as "left" | "center" | "right",
              transform: `translate(-50%, -50%) rotate(${editing.rotation}deg)`,
            }}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => props.onTextChange(editing.id, e.target.value)}
            onBlur={() => props.onEditing(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                props.onEditing(null);
              }
              e.stopPropagation();
            }}
          />
        )}
      </div>
    </div>
  );
}
