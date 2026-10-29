import { useEffect, useState } from "react";
import { Icon, TimecodeInput } from "@/components";
import { formatMs, parseTimecodeMs } from "@/components/media";
import { FilesService, MediaService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { effectParams, isHeicPath, isTiffPath, type ImageBox } from "./logic";
import styles from "./RedactView.module.css";

/** URL of a picture the webview can show: the file itself, or a Go-decoded preview for TIFF. */
export function useImageUrl(path: string | null, thumbMax = 1600): { url: string; error: string } {
  const [state, setState] = useState<{ path: string | null; url: string; error: string }>({ path: null, url: "", error: "" });
  useEffect(() => {
    if (!path) return;
    if (isHeicPath(path)) {
      setState({ path, url: "", error: "HEIC photos can't be previewed here." });
      return;
    }
    let cancelled = false;
    (isTiffPath(path) ? FilesService.ImageThumb(path, thumbMax) : MediaService.URLFor(path))
      .then((url) => !cancelled && setState({ path, url, error: "" }))
      .catch((e) => !cancelled && setState({ path, url: "", error: toAppError(e).message }));
    return () => {
      cancelled = true;
    };
  }, [path, thumbMax]);
  if (!path || state.path !== path) return { url: "", error: "" };
  return state;
}

/** A small cached thumbnail (a file tile for HEIC or when it can't be read). */
export function Thumb({ path, size = 240, className }: { path: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (isHeicPath(path)) return;
    let cancelled = false;
    FilesService.ImageThumb(path, size)
      .then((url) => !cancelled && setSrc({ path, url }))
      .catch(() => !cancelled && setSrc({ path, url: "" }));
    return () => {
      cancelled = true;
    };
  }, [path, size]);
  const url = src?.path === path ? src.url : "";
  if (!url) {
    return (
      <span className={`${styles.tile} ${className ?? ""}`} aria-hidden>
        <Icon name="image" size={20} />
      </span>
    );
  }
  return <img className={`${styles.thumb} ${className ?? ""}`} src={url} alt="" draggable={false} />;
}

/** A timecode text field that commits on blur or Enter and reverts when invalid. */
export function TimeField({ label, ms, onCommit }: { label: string; ms: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatMs(ms);
  const commit = () => {
    if (text === null) return;
    const v = parseTimecodeMs(text);
    if (v !== null) onCommit(v);
    setText(null);
  };
  return (
    <TimecodeInput
      aria-label={label}
      className={styles.time}
      value={shown}
      invalid={text !== null && parseTimecodeMs(text) === null}
      onChange={setText}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(null);
      }}
    />
  );
}

/** Approximate effect inside a box, drawn from the loaded picture (blur / pixelate / solid). */
export function EffectFill({ img, box, rectW, rectH, style, strength }: { img: HTMLImageElement | null; box: ImageBox | { x: number; y: number; w: number; h: number }; rectW: number; rectH: number; style: string; strength: number }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const dispW = Math.max(1, box.w * rectW);
  const dispH = Math.max(1, box.h * rectH);
  useEffect(() => {
    if (!canvas || !img || !img.naturalWidth) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const k = Math.min(1, 320 / Math.max(dispW, dispH));
    const cw = Math.max(1, Math.round(dispW * k));
    const ch = Math.max(1, Math.round(dispH * k));
    canvas.width = cw;
    canvas.height = ch;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const sx = box.x * nw;
    const sy = box.y * nh;
    const sw = Math.max(1, box.w * nw);
    const sh = Math.max(1, box.h * nh);
    const p = effectParams(style, strength, cw, ch);
    if (style === "solid") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
    } else if (style === "pixelate") {
      const sc = document.createElement("canvas");
      sc.width = Math.max(1, Math.round(cw / p.block));
      sc.height = Math.max(1, Math.round(ch / p.block));
      sc.getContext("2d")?.drawImage(img, sx, sy, sw, sh, 0, 0, sc.width, sc.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sc, 0, 0, cw, ch);
    } else {
      ctx.filter = `blur(${p.sigma}px)`;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
    }
  }, [canvas, img, box.x, box.y, box.w, box.h, dispW, dispH, style, strength]);
  return <canvas ref={setCanvas} className={styles.fillCanvas} aria-hidden />;
}
