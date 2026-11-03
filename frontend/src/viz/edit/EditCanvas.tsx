/**
 * The Edit Studio preview host (Phase 9 SPEC §8.8). WP-ES3 owns it; the props
 * are frozen. The Wave 0 version drives the stub engine with no frame
 * provider: it renders on each timeMs change and never awaits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GLUnavailableError } from "../gl/core";
import { compileEdit } from "./compile";
import { EditEngine } from "./engine";
import type { EditInputs, FrameProvider } from "./types";
import styles from "./EditCanvas.module.css";

export interface EditCanvasStats {
  fps: number;
  dropped: number;
  waiting: number;
}

export interface EditCanvasProps {
  /** null = "nothing to show" placeholder. */
  inputs: EditInputs | null;
  /** Preview size (§14.3). */
  width: number;
  height: number;
  /** Timeline ms from the transport (audio clock). */
  timeMs: number;
  playing: boolean;
  quality: "full" | "draft";
  onStats?(s: EditCanvasStats): void;
  /** The canvas element, for overlays and thumbnails. */
  onCanvas?(c: HTMLCanvasElement | null): void;
  className?: string;
}

const NO_FRAMES: FrameProvider = {
  prepare: () => Promise.resolve(),
  frame: () => null,
  image: () => null,
  hint: () => undefined,
  dispose: () => undefined,
};

export function EditCanvas({ inputs, width, height, timeMs, playing, quality, onStats, onCanvas, className }: EditCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EditEngine | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  void playing;
  void onStats;

  const fps = inputs?.project.fps ?? 30;
  const seed = inputs?.project.seed ?? 1;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      engineRef.current = new EditEngine(canvas, { width, height, fps, seed, quality, inWorker: false });
      setUnavailable(null);
    } catch (e) {
      engineRef.current = null;
      setUnavailable(e instanceof GLUnavailableError ? e.message : "The preview couldn't start");
    }
    onCanvas?.(canvas);
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      onCanvas?.(null);
    };
    // The engine is rebuilt only when its size, fps or seed changes.
  }, [width, height, fps, seed]);

  const compiled = useMemo(() => (inputs ? compileEdit(inputs, { width, height, fps }) : null), [inputs, width, height, fps]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e || !compiled) return;
    e.setEdit(compiled);
    e.render(timeMs, NO_FRAMES);
  }, [compiled, timeMs]);

  return (
    <div className={`${styles.root} ${className ?? ""}`}>
      {unavailable ? <p className={styles.unavailable}>{unavailable}</p> : <canvas ref={canvasRef} className={styles.canvas} width={width} height={height} />}
    </div>
  );
}
