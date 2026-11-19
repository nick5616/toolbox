/** A clip's waveform (Phase 21 SPEC §B2): one canvas per visible clip, drawn only for the part in view. */
import { useEffect, useRef } from "react";
import type { EditClip } from "@/lib/api";
import { usePeaks } from "@/editor/audio/peaks";
import { MAX_COLUMNS, peakColumns, visibleSourceRange } from "./peakColumns";
import styles from "./Timeline.module.css";

export interface WaveformProps {
  clip: EditClip;
  fps: number;
  pps: number;
  /** The clip's width and the part of it in view (clip-relative px). */
  widthPx: number;
  viewFromPx: number;
  viewToPx: number;
  heightPx: number;
}

export function Waveform({ clip, fps, pps, widthPx, viewFromPx, viewToPx, heightPx }: WaveformProps) {
  const peaks = usePeaks(clip.path || null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const x0 = Math.max(0, Math.floor(viewFromPx));
  const x1 = Math.min(widthPx, Math.ceil(viewToPx), x0 + MAX_COLUMNS);
  const w = Math.max(0, x1 - x0);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !peaks || w <= 0 || heightPx <= 0) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(heightPx * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, heightPx);
    const range = visibleSourceRange(clip, fps, pps, x0, x1);
    const cols = peakColumns(peaks, range.fromMs, range.toMs, w);
    ctx.fillStyle = getComputedStyle(cv).getPropertyValue("--fg-subtle").trim() || "#888";
    const mid = heightPx / 2;
    for (let c = 0; c < w; c++) {
      const top = mid - (cols.max[c] as number) * mid;
      const bottom = mid - (cols.min[c] as number) * mid;
      ctx.fillRect(c, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks, clip, fps, pps, x0, x1, w, heightPx]);

  if (!peaks || w <= 0) return null;
  return <canvas ref={canvas} className={styles.wave} style={{ left: x0, width: w, height: heightPx }} aria-hidden="true" data-waveform />;
}
