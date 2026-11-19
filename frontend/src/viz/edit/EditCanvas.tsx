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
import { filesForQuality } from "../frames/tier";
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
  /** "draft" plays the preview-tier streams (default); "full" the export tier (needs `fullFiles`) and shows a "Full" chip. */
  quality: "full" | "draft";
  /** Export-tier files for Full (same keys as `inputs.files`); streams missing here fall back to Draft's. */
  fullFiles?: EditFiles | null;
  /** Receives the preview's imperative handle (samplePre) while the engine is alive, null otherwise. */
  onHandle?(h: EditCanvasHandle | null): void;
  onStats?(s: EditCanvasStats): void;
  /** The canvas element, for overlays and thumbnails. */
  onCanvas?(c: HTMLCanvasElement | null): void;
  className?: string;
}

/** What other parts (the eyedropper) can ask of the live preview. */
export interface EditCanvasHandle {
  /** The clip's own source pixel (pre-effects), 5 x 5 average at source UV, sRGB 0..1; null when unavailable. */
  samplePre(clipId: string, u: number, v: number): [number, number, number] | null;
}

/** Window-level registry (one preview per window): `getEditCanvasHandle()?.samplePre(...)`. */
let activeHandle: EditCanvasHandle | null = null;
export function getEditCanvasHandle(): EditCanvasHandle | null {
  return activeHandle;
}

/** Idle time before read-ahead starts while paused (SPEC B5). */
export const READ_AHEAD_IDLE_MS = 150;

const NO_FILES: EditFiles = { streams: {}, images: {} };
const AHEAD_SECONDS = 0.5;
const MAX_AHEAD_KEYS = 240;

/** The keys the next ~0.5 s of playback needs, in play order, without duplicates. */
export function aheadKeys(needs: (tMs: number) => FrameKey[], tMs: number, fps: number, dir: 1 | -1 = 1, stepFrames = 1): FrameKey[] {
  const out: FrameKey[] = [];
  const seen = new Set<string>();
  const n = Math.ceil(AHEAD_SECONDS * fps);
  for (let i = 1; i <= n && out.length < MAX_AHEAD_KEYS; i++) {
    const at = tMs + (dir * i * stepFrames * 1000) / fps;
    if (at < 0) break;
    for (const k of needs(at)) {
      const id = `${k.stream}#${k.frame}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  }
  return out;
}

/** Keys within +-0.5 s of tMs (the playhead's own first), for the paused read-ahead. */
export function aroundKeys(needs: (tMs: number) => FrameKey[], tMs: number, fps: number): FrameKey[] {
  const out: FrameKey[] = [];
  const seen = new Set<string>();
  for (const list of [needs(tMs), aheadKeys(needs, tMs, fps, 1), aheadKeys(needs, tMs, fps, -1)]) {
    for (const k of list) {
      const id = `${k.stream}#${k.frame}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(k);
      }
    }
  }
  return out;
}

export function EditCanvas({ inputs, width, height, timeMs, playing, quality, fullFiles, onHandle, onStats, onCanvas, className }: EditCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EditEngine | null>(null);
  const providerRef = useRef<EditFrameProvider | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const decoder = useMemo(() => hasVideoDecoder(), []);

  const fps = inputs?.project.fps ?? 30;
  const seed = inputs?.project.seed ?? 1;
  const draftFiles = inputs?.files ?? NO_FILES;
  const files = useMemo(() => filesForQuality(draftFiles, fullFiles, quality), [draftFiles, fullFiles, quality]);

  const compiled = useMemo<CompiledEditFull | null>(() => (inputs ? compileEdit(inputs, { width, height, fps }) : null), [inputs, width, height, fps]);

  const latest = useRef({ timeMs, playing, compiled, fps });
  latest.current = { timeMs, playing, compiled, fps };
  const statsRef = useRef({ renders: 0, waiting: 0, dropped: 0, lastT: -1, good: false, ready: false });
  const cbRef = useRef({ onStats, onCanvas, onHandle });
  cbRef.current = { onStats, onCanvas, onHandle };

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
    const s = statsRef.current;
    let keys = e.needs(t);
    if (!decoder) keys = keys.filter((k) => p.isImageKey(k.stream));
    // Reverse play: the clock seeks backwards, so look behind the playhead, GOP by GOP.
    const reverse = pl && s.lastT >= 0 && t < s.lastT;
    const step = pl && s.lastT >= 0 ? Math.max(1, Math.round((Math.abs(t - s.lastT) * f) / 1000)) : 1;
    p.setReverse(reverse);
    if (decoder) p.hint(pl ? aheadKeys((x) => e.needs(x), t, f, reverse ? -1 : 1, step) : [], pl);
    p.prepare(keys, false).catch(() => undefined);
    s.ready = p.isReady(keys);
    // A clip still preparing keeps the last good picture on screen instead of black.
    if (decoder && s.good && !s.ready && !p.hasStandIn(keys)) {
      s.waiting++;
      return;
    }
    e.render(t, p);
    s.renders++;
    if (s.ready || p.hasStandIn(keys)) s.good = true;
    if (!s.ready) s.waiting++;
    if (pl && s.lastT >= 0 && t > s.lastT) s.dropped += Math.max(0, Math.floor((t - s.lastT) / (1000 / f) + 0.25) - 1);
    if (pl && s.lastT >= 0 && t < s.lastT) s.dropped += Math.max(0, Math.floor((s.lastT - t) / (1000 / f) + 0.25) - 1);
    s.lastT = pl ? t : -1;
  }, [decoder]);

  // The engine is rebuilt only when its size, fps or seed changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const e = new EditEngine(canvas, { width, height, fps, seed, quality, inWorker: false });
      engineRef.current = e;
      statsRef.current.good = false;
      if (latest.current.compiled) e.setEdit(latest.current.compiled);
      const handle: EditCanvasHandle = { samplePre: (id, u, v) => e.samplePre(id, u, v) };
      activeHandle = handle;
      cbRef.current.onHandle?.(handle);
      setUnavailable(null);
    } catch (err) {
      engineRef.current = null;
      setUnavailable(err instanceof GLUnavailableError ? err.message : "The preview couldn't start");
    }
    cbRef.current.onCanvas?.(canvas);
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      activeHandle = null;
      cbRef.current.onHandle?.(null);
      cbRef.current.onCanvas?.(null);
    };
    // quality is applied below without rebuilding.
  }, [width, height, fps, seed]);

  useEffect(() => {
    engineRef.current?.setQuality(quality);
  }, [quality]);

  // The compiled edit reaches the engine only when it changes (identity), never per frame.
  useEffect(() => {
    if (compiled) engineRef.current?.setEdit(compiled);
  }, [compiled, unavailable, width, height, fps, seed]);

  // Draw on every time or edit change. While playing, only when the output
  // frame changes (the audio clock ticks faster than the edit's fps).
  const drawn = useRef<{ k: number; c: unknown }>({ k: -1, c: null });
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !compiled) return;
    const k = Math.floor((timeMs * fps) / 1000 + 1e-6);
    if (playing && drawn.current.k === k && drawn.current.c === compiled) return;
    drawn.current = { k, c: compiled };
    renderNow();
  }, [compiled, timeMs, playing, renderNow, width, height, fps, seed, unavailable]);

  // Paused: after 150 ms idle, decode +-0.5 s around the playhead (a seek cancels it in the provider).
  useEffect(() => {
    if (playing || !decoder) return;
    const id = setTimeout(() => {
      const e = engineRef.current;
      const p = providerRef.current;
      if (!e || !p) return;
      p.setReverse(false);
      p.readAhead(aroundKeys((x) => e.needs(x), latest.current.timeMs, latest.current.fps).filter((k) => !p.isImageKey(k.stream)));
    }, READ_AHEAD_IDLE_MS);
    return () => clearTimeout(id);
  }, [timeMs, playing, compiled, decoder, files]);

  // Frames arriving while paused redraw the current time (coalesced to one per animation frame).
  useEffect(() => {
    const p = providerRef.current;
    if (!p) return;
    let queued = false;
    const off = p.onChange(() => {
      setDecodeError((cur) => (cur === p.lastError ? cur : p.lastError));
      if (latest.current.playing || queued || statsRef.current.ready) return; // what's on screen is already exact
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
      {!unavailable && quality === "full" && (
        <span className={styles.chip} title="Previewing the full-quality streams. Playback may drop frames.">
          Full
        </span>
      )}
      {!unavailable && !decoder && hasVideo && <p className={styles.banner}>This system can&apos;t decode video for Edit Studio</p>}
      {!unavailable && decoder && decodeError && <p className={styles.banner} title={decodeError}>A clip couldn&apos;t be decoded</p>}
    </div>
  );
}
