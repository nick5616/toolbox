/**
 * A live WebGL canvas rendering a show at a time (SPEC.md §9.1): the preview
 * in the designer and the background of the Lyric Video and Subtitles
 * previews. It letterboxes to `aspect` inside its box and renders on each
 * `timeMs` change (callers drive time from their player).
 *
 * Overlay mode renders the engine's packed frame off-screen and unpacks it
 * into a transparent 2D canvas, so it can sit over a video.
 */
import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/cx";
import type { Analysis } from "@/viz/analysis";
import { Engine } from "@/viz/engine";
import { GLUnavailableError } from "@/viz/gl/core";
import type { Show } from "@/viz/types";
import { drawOverlay, fitSize, loadBitmap } from "./host";
import styles from "./VisualsCanvas.module.css";

export interface VisualsCanvasProps {
  show: Show | null;
  analysis: Analysis | null;
  timeMs: number;
  /** Output width / height. */
  aspect: number;
  mode: "opaque" | "overlay";
  /** "auto" drops to draft below 45 fps for 2 s (SPEC.md §6.1). */
  quality?: "auto" | "full" | "draft";
  /** Optional textures (cover art, a background image). */
  cover?: string | null; // /media URL
  image?: string | null;
  /** Reports the measured fps about once a second. */
  onFps?(fps: number): void;
  className?: string;
}

interface Box {
  w: number;
  h: number;
}

const FPS_FLOOR = 45;
const DRAFT_AFTER_MS = 2000;

export function VisualsCanvas({ show, analysis, timeMs, aspect, mode, quality = "auto", cover, image, onFps, className }: VisualsCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const shownShow = useRef<Show | null>(null);
  const shownAnalysis = useRef<Analysis | null>(null);
  const [box, setBox] = useState<Box>({ w: 640, h: 360 });
  const [engineGen, setEngineGen] = useState(0);
  const [texGen, setTexGen] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState(false);
  const fpsCb = useRef(onFps);
  fpsCb.current = onFps;

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const size = fitSize(box.w, box.h, aspect, dpr);

  // Track the box.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBox((b) => (Math.abs(b.w - r.width) < 0.5 && Math.abs(b.h - r.height) < 0.5 ? b : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One engine per mode; the canvas is remounted with the mode (a canvas keeps its first context type).
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    const canvas = mode === "overlay" ? document.createElement("canvas") : canvasRef.current;
    if (!canvas) return;
    let engine: Engine;
    try {
      const s = sizeRef.current;
      engine = new Engine(canvas, { width: s.w, height: s.h, mode, quality: "full", seed: 1, fps: 60, inWorker: false });
    } catch (e) {
      setUnavailable(true);
      if (!(e instanceof GLUnavailableError)) console.warn("visualizer canvas", e);
      return;
    }
    setUnavailable(false);
    engineRef.current = engine;
    shownShow.current = null;
    shownAnalysis.current = null;
    setEngineGen((g) => g + 1);
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [mode]);

  // Textures.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    let alive = true;
    const bitmaps: ImageBitmap[] = [];
    const load = async (url: string | null | undefined, key: "cover" | "image") => {
      if (!url) {
        engine.setTextures({ [key]: null });
        return;
      }
      try {
        const bmp = await loadBitmap(url);
        bitmaps.push(bmp);
        if (alive && engineRef.current === engine) engine.setTextures({ [key]: bmp });
      } catch {
        /* the design renders without the texture */
      }
    };
    void Promise.all([load(cover, "cover"), load(image, "image")]).then(() => {
      if (alive) setTexGen((g) => g + 1);
    });
    return () => {
      alive = false;
      for (const b of bitmaps) b.close?.();
    };
  }, [cover, image, engineGen]);

  // Quality.
  useEffect(() => {
    engineRef.current?.setQuality(quality === "draft" || (quality === "auto" && draft) ? "draft" : "full");
  }, [quality, draft, engineGen]);
  useEffect(() => {
    if (quality !== "auto") setDraft(false);
  }, [quality]);

  // Render.
  const frames = useRef({ count: 0, since: 0, slowFor: 0 });
  useEffect(() => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !analysis || !show) return;
    if (shownAnalysis.current !== analysis) {
      engine.setAnalysis(analysis);
      shownAnalysis.current = analysis;
      shownShow.current = null;
    }
    if (shownShow.current !== show) {
      engine.setShow(show);
      shownShow.current = show;
    }
    if (engine.options.width !== size.w || engine.options.height !== size.h) engine.resize(size.w, size.h);
    try {
      engine.render(timeMs);
    } catch (e) {
      console.warn("visualizer render", e);
      return;
    }
    if (mode === "overlay" && canvas) {
      if (canvas.width !== size.w) canvas.width = size.w;
      if (canvas.height !== size.h) canvas.height = size.h;
      const ctx = canvas.getContext("2d");
      if (ctx) drawOverlay(engine.canvas as HTMLCanvasElement, ctx, size.w, size.h);
    }
    // fps: frames rendered per second while time keeps changing.
    const now = performance.now();
    const f = frames.current;
    if (f.since === 0) f.since = now;
    f.count++;
    if (now - f.since >= 1000) {
      const fps = (f.count * 1000) / (now - f.since);
      fpsCb.current?.(Math.round(fps * 10) / 10);
      // Only a continuously animating canvas (a player) can be "slow".
      if (f.count >= 5 && fps < FPS_FLOOR) f.slowFor += now - f.since;
      else f.slowFor = 0;
      if (f.slowFor >= DRAFT_AFTER_MS && quality === "auto") setDraft(true);
      f.count = 0;
      f.since = now;
    }
  }, [show, analysis, timeMs, size.w, size.h, mode, quality, engineGen, texGen, draft]);

  if (unavailable) {
    return (
      <div ref={rootRef} className={cx(styles.root, className)}>
        <p className={styles.unavailable} role="status">
          This computer&apos;s graphics can&apos;t run the visualizer, so the live preview is off.
        </p>
      </div>
    );
  }
  return (
    <div ref={rootRef} className={cx(styles.root, className)}>
      <canvas key={mode} ref={canvasRef} className={styles.canvas} style={{ width: size.cssW, height: size.cssH, background: mode === "overlay" ? "transparent" : undefined }} aria-label="Visual preview" />
    </div>
  );
}
