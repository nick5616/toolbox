/**
 * The Edit Studio preview host (Phase 9 SPEC §8.8). Owns one EditEngine and
 * one main-thread FrameProvider (preview-tier URLs). On each timeMs change it
 * hints the frames the next half second needs, asks for the current ones
 * (inexact) and renders; when frames arrive while paused it renders again.
 * Nothing in the render path awaits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GLUnavailableError } from "../gl/core";
import { hasVideoDecoder } from "../frames/decoder";
import { EditFrameProvider } from "../frames/provider";
import { compileEdit, type CompiledEditFull } from "./compile";
import { EditEngine } from "./engine";
import type { EditFiles, EditInputs, FrameKey } from "./types";
import styles from "./EditCanvas.module.css";

export interface EditCanvasStats {
  /** Frames drawn in the last second. */
  fps: number;
  /** Frames skipped since playback started (the clock ran ahead of the renderer). */
  dropped: number;
  /** Frames drawn in the last second with a frame still decoding. */
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

const NO_FILES: EditFiles = { streams: {}, images: {} };
const AHEAD_SECONDS = 0.5;
const MAX_AHEAD_KEYS = 240;

/** The keys the next ~0.5 s of playback needs, in play order, without duplicates. */
export function aheadKeys(needs: (tMs: number) => FrameKey[], tMs: number, fps: number): FrameKey[] {
  const out: FrameKey[] = [];
  const seen = new Set<string>();
  const n = Math.ceil(AHEAD_SECONDS * fps);
  for (let i = 1; i <= n && out.length < MAX_AHEAD_KEYS; i++) {
    for (const k of needs(tMs + (i * 1000) / fps)) {
      const id = `${k.stream}#${k.frame}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  }
  return out;
}

export function EditCanvas({ inputs, width, height, timeMs, playing, quality, onStats, onCanvas, className }: EditCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EditEngine | null>(null);
  const providerRef = useRef<EditFrameProvider | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const decoder = useMemo(() => hasVideoDecoder(), []);

  const fps = inputs?.project.fps ?? 30;
  const seed = inputs?.project.seed ?? 1;
  const files = inputs?.files ?? NO_FILES;

  const compiled = useMemo<CompiledEditFull | null>(() => (inputs ? compileEdit(inputs, { width, height, fps }) : null), [inputs, width, height, fps]);

  const latest = useRef({ timeMs, playing, compiled, fps });
  latest.current = { timeMs, playing, compiled, fps };
  const statsRef = useRef({ renders: 0, waiting: 0, dropped: 0, lastT: -1 });
  const cbRef = useRef({ onStats, onCanvas });
  cbRef.current = { onStats, onCanvas };

  // The provider lives as long as the host.
  useEffect(() => {
    const p = new EditFrameProvider({ files, mode: "preview" });
    providerRef.current = p;
    return () => {
      p.dispose();
      providerRef.current = null;
    };
    // files are pushed through setFiles below.
  }, []);

  useEffect(() => {
    providerRef.current?.setFiles(files);
  }, [files]);

  const renderNow = useCallback(() => {
    const e = engineRef.current;
    const p = providerRef.current;
    const { timeMs: t, playing: pl, compiled: c, fps: f } = latest.current;
    if (!e || !p || !c) return;
    let keys = e.needs(t);
    if (!decoder) keys = keys.filter((k) => p.isImageKey(k.stream));
    if (decoder) p.hint(pl ? aheadKeys((x) => e.needs(x), t, f) : [], pl);
    p.prepare(keys, false).catch(() => undefined);
    e.render(t, p);
    const s = statsRef.current;
    s.renders++;
    if (!p.isReady(keys)) s.waiting++;
    if (pl && s.lastT >= 0 && t > s.lastT) s.dropped += Math.max(0, Math.floor((t - s.lastT) / (1000 / f) + 0.25) - 1);
    s.lastT = pl ? t : -1;
  }, [decoder]);

  // The engine is rebuilt only when its size, fps or seed changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const e = new EditEngine(canvas, { width, height, fps, seed, quality, inWorker: false });
      engineRef.current = e;
      if (latest.current.compiled) e.setEdit(latest.current.compiled);
      setUnavailable(null);
    } catch (err) {
      engineRef.current = null;
      setUnavailable(err instanceof GLUnavailableError ? err.message : "The preview couldn't start");
    }
    cbRef.current.onCanvas?.(canvas);
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      cbRef.current.onCanvas?.(null);
    };
    // quality is applied below without rebuilding.
  }, [width, height, fps, seed]);

  useEffect(() => {
    engineRef.current?.setQuality(quality);
  }, [quality]);

  // Draw on every time or edit change. While playing, only when the output
  // frame changes (the audio clock ticks faster than the edit's fps).
  const drawn = useRef<{ k: number; c: unknown }>({ k: -1, c: null });
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !compiled) return;
    const k = Math.floor((timeMs * fps) / 1000 + 1e-6);
    if (playing && drawn.current.k === k && drawn.current.c === compiled) return;
    drawn.current = { k, c: compiled };
    e.setEdit(compiled);
    renderNow();
  }, [compiled, timeMs, playing, renderNow, width, height, fps, seed, unavailable]);

  // Frames arriving while paused redraw the current time (coalesced to one per animation frame).
  useEffect(() => {
    const p = providerRef.current;
    if (!p) return;
    let queued = false;
    const off = p.onChange(() => {
      setDecodeError((cur) => (cur === p.lastError ? cur : p.lastError));
      if (latest.current.playing || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        renderNow();
      });
    });
    return off;
  }, [renderNow]);

  // Stats, once a second.
  useEffect(() => {
    const id = setInterval(() => {
      const s = statsRef.current;
      cbRef.current.onStats?.({ fps: s.renders, dropped: s.dropped, waiting: s.waiting });
      s.renders = 0;
      s.waiting = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const hasVideo = !!inputs && Object.keys(inputs.files.streams).length > 0;
  return (
    <div className={`${styles.root} ${className ?? ""}`}>
      {unavailable ? <p className={styles.unavailable}>{unavailable}</p> : <canvas ref={canvasRef} className={styles.canvas} width={width} height={height} />}
      {!unavailable && !decoder && hasVideo && <p className={styles.banner}>This system can&apos;t decode video for Edit Studio</p>}
      {!unavailable && decoder && decodeError && <p className={styles.banner} title={decodeError}>A clip couldn&apos;t be decoded</p>}
    </div>
  );
}
