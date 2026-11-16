import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { cx, Icon } from "@/components";
import { clampZoom, framedLayout, frameSize, panFromDrag } from "./framing";
import styles from "./FramedMedia.module.css";

/** Pictures' pixel sizes by URL, so a remounted frame lays out in its first render. */
const SIZES_MAX = 120;
const sizes = new Map<string, { w: number; h: number }>();

export function rememberSize(url: string, w: number, h: number): void {
  if (!url || w <= 0 || h <= 0) return;
  sizes.delete(url);
  sizes.set(url, { w, h });
  while (sizes.size > SIZES_MAX) {
    const oldest = sizes.keys().next();
    if (oldest.done) break;
    sizes.delete(oldest.value);
  }
}

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
  /**
   * A video drawn over the picture with the same framing (the picture is a
   * frame of it, so it has the same shape). Shown once it has a frame to show.
   */
  video?: { src: string; ref: Ref<HTMLVideoElement>; muted: boolean; visible: boolean };
  children?: ReactNode;
}

/**
 * A picture cover-fitted into a frame of the post's shape with the slide's pan,
 * zoom and rotation, using the same window maths as the Go exporter.
 */
export function FramedMedia({ url, aspect, framing, onFraming, onFramingLive, onFramingEnd, placeholderIcon = "image", placeholderLabel, placeholderTone, loading, alt = "", fit, className, video, children }: FramedMediaProps) {
  const frame = useRef<HTMLDivElement>(null);
  // The measured picture, tied to its URL: a small data URL can finish loading
  // before an effect runs, so the size is never reset by an effect. A picture
  // seen before (or decoded by the prefetch) has its size already.
  const [measured, setMeasured] = useState<{ url: string; w: number; h: number } | null>(null);
  const known = sizes.get(url);
  const size = measured && measured.url === url ? measured : known ? { url, ...known } : null;
  const measure = (w: number, h: number) => {
    rememberSize(url, w, h);
    setMeasured({ url, w, h });
  };
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number; last: Partial<Pick<Framing, "panX" | "panY">> | null } | null>(null);
  const live = useRef({ framing, onFraming });
  live.current = { framing, onFraming };

  // An image that was already decoded (cached) may not fire load after mount.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth > 0 && !(measured?.url === url)) measure(el.naturalWidth, el.naturalHeight);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const fs = frameSize(aspect);
  const style = { aspectRatio: `${fs.w} / ${fs.h}`, "--ratio": fs.w / fs.h } as CSSProperties;
  const layout = size ? framedLayout(size.w, size.h, framing.rotation, aspect, framing.zoom, framing.panX, framing.panY) : null;
  const interactive = !!onFraming && !!layout;
  const mediaStyle: CSSProperties | undefined = layout
    ? { width: `${layout.img.width}%`, height: `${layout.img.height}%`, transform: `translate(-50%, -50%) rotate(${layout.rotation}deg)` }
    : undefined;

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
            ref={img}
            src={url}
            alt={alt}
            draggable={false}
            className={styles.img}
            style={mediaStyle}
            onLoad={(e) => measure(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          />
          {video && (
            <video
              ref={video.ref}
              src={video.src}
              muted={video.muted}
              playsInline
              preload="auto"
              disablePictureInPicture
              aria-hidden="true"
              className={cx(styles.img, styles.video, !video.visible && styles.hidden)}
              style={mediaStyle}
            />
          )}
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
