import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx, Icon } from "@/components";
import { clampZoom, framedLayout, frameSize, panFromDrag } from "./framing";
import styles from "./FramedMedia.module.css";

export interface Framing {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
}

export interface FramedMediaProps {
  url: string;
  aspect: string;
  framing: Framing;
  /** When set the picture can be dragged (pan) and wheeled (zoom). */
  onFraming?: (next: Partial<Pick<Framing, "zoom" | "panX" | "panY">>) => void;
  /**
   * A pan drag reports here while it moves (not recorded) and then once on release
   * with the final framing. Without these a drag calls `onFraming` on every move.
   */
  onFramingLive?: (next: Partial<Pick<Framing, "zoom" | "panX" | "panY">>) => void;
  onFramingEnd?: (next: Partial<Pick<Framing, "zoom" | "panX" | "panY">>) => void;
  /** Shown when there is no picture. */
  placeholderIcon?: string;
  /** A line under the placeholder icon (the "missing media" state). */
  placeholderLabel?: string;
  placeholderTone?: "warn";
  loading?: boolean;
  alt?: string;
  /** Size to fit the parent box (which must be a size container) instead of its width. */
  fit?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * A picture cover-fitted into a frame of the post's shape with the slide's pan,
 * zoom and rotation, using the same window maths as the Go exporter.
 */
export function FramedMedia({ url, aspect, framing, onFraming, onFramingLive, onFramingEnd, placeholderIcon = "image", placeholderLabel, placeholderTone, loading, alt = "", fit, className, children }: FramedMediaProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number; last: Partial<Pick<Framing, "panX" | "panY">> | null } | null>(null);
  const live = useRef({ framing, onFraming });
  live.current = { framing, onFraming };

  useEffect(() => setSize(null), [url]);

  const fs = frameSize(aspect);
  const style = { aspectRatio: `${fs.w} / ${fs.h}`, "--ratio": fs.w / fs.h } as CSSProperties;
  const layout = size ? framedLayout(size.w, size.h, framing.rotation, aspect, framing.zoom, framing.panX, framing.panY) : null;
  const interactive = !!onFraming && !!layout;

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = frame.current;
    if (!el || !onFraming) return;
    const onWheel = (e: WheelEvent) => {
      const l = live.current;
      if (!l.onFraming) return;
      e.preventDefault();
      l.onFraming({ zoom: clampZoom(l.framing.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [!!onFraming]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: framing.panX, panY: framing.panY, last: null };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !layout || !onFraming) return;
    const w = frame.current?.clientWidth ?? 0;
    const next = panFromDrag(d, layout, e.clientX - d.x, e.clientY - d.y, w);
    if (onFramingLive) {
      d.last = next;
      onFramingLive(next);
    } else onFraming(next);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    drag.current = null;
    if (onFramingLive && d.last) onFramingEnd?.(d.last);
  };

  return (
    <div
      ref={frame}
      className={cx(styles.frame, fit && styles.fit, interactive && styles.interactive, className)}
      style={style}
      data-testid="framed-media"
      data-tip={interactive ? "Drag to move the picture inside the frame, scroll to zoom" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {url ? (
        <div
          className={styles.box}
          style={
            layout
              ? { left: `${layout.box.left}%`, top: `${layout.box.top}%`, width: `${layout.box.width}%`, height: `${layout.box.height}%` }
              : { opacity: 0, inset: 0 }
          }
        >
          <img
            src={url}
            alt={alt}
            draggable={false}
            className={styles.img}
            style={
              layout
                ? { width: `${layout.img.width}%`, height: `${layout.img.height}%`, transform: `translate(-50%, -50%) rotate(${layout.rotation}deg)` }
                : undefined
            }
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        </div>
      ) : (
        <div className={cx(styles.placeholder, placeholderTone === "warn" && styles.warn)} role={placeholderLabel ? "img" : undefined} aria-label={placeholderLabel}>
          <Icon name={loading ? "loader" : placeholderIcon} size={20} />
          {placeholderLabel && !loading && <span className={styles.placeholderLabel}>{placeholderLabel}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
