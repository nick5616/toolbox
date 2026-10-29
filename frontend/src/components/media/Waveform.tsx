import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cx } from "../cx";
import { clamp } from "./logic";
import styles from "./Waveform.module.css";

export interface WaveformProps {
  /** Peaks 0..1. */
  peaks: number[];
  /** 0..1 portion already played (drawn in the accent colour). */
  progress?: number;
  /** Optional highlighted band, 0..1 of the width (e.g. the 10 s preview window). */
  band?: { start: number; end: number };
  onSeek?: (fraction: number) => void;
  height?: number;
  className?: string;
}

/** Reduces peaks to one value per column (max of the bucket). Exported for tests. */
export function columnPeaks(peaks: ArrayLike<number>, columns: number): number[] {
  const out: number[] = new Array<number>(Math.max(0, columns)).fill(0);
  const n = peaks.length;
  if (n === 0 || columns <= 0) return out;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * n) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * n) / columns));
    let m = 0;
    for (let i = from; i < to && i < n; i++) m = Math.max(m, Math.abs(peaks[i] ?? 0));
    out[c] = Math.min(1, m);
  }
  return out;
}

/** Canvas waveform (SPEC.md §3.11). */
export function Waveform({ peaks, progress = 0, band, onSeek, height = 56, className }: WaveformProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    const el = wrap.current;
    if (!cv || !el || width <= 0) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const css = getComputedStyle(el);
    const accent = css.getPropertyValue("--accent").trim() || "#ff8c42";
    const idle = css.getPropertyValue("--fg-subtle").trim() || "#6b6d76";
    const bandCol = css.getPropertyValue("--accent-soft").trim() || "rgba(255,140,66,0.14)";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (band) {
      ctx.fillStyle = bandCol;
      const x0 = clamp(band.start, 0, 1) * width;
      const x1 = clamp(band.end, 0, 1) * width;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }
    const colW = 2;
    const gap = 1;
    const cols = Math.max(1, Math.floor(width / (colW + gap)));
    const cp = columnPeaks(peaks, cols);
    const mid = height / 2;
    const playedX = clamp(progress, 0, 1) * width;
    for (let c = 0; c < cols; c++) {
      const x = c * (colW + gap);
      const h = Math.max(1, (cp[c] ?? 0) * (height - 4));
      ctx.fillStyle = x + colW <= playedX ? accent : idle;
      ctx.fillRect(x, mid - h / 2, colW, h);
    }
  }, [peaks, progress, band, width, height]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    onSeek(clamp((e.clientX - r.left) / r.width, 0, 1));
  };

  return (
    <div
      ref={wrap}
      data-testid="waveform"
      className={cx(styles.root, onSeek && styles.seekable, className)}
      style={{ height }}
      onClick={onClick}
    >
      <canvas ref={canvas} className={styles.canvas} style={{ width: "100%", height }} aria-hidden="true" />
    </div>
  );
}
