/**
 * Transform, mask and safe-zone overlays on the preview (§14.8). The overlay
 * sits over the canvas's on-screen box (the positioned parent is the preview
 * section); everything inside is drawn in canvas pixels through an SVG whose
 * viewBox is the preview size, so CSS scaling needs no extra maths.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseMasks } from "@/viz/edit/schema";
import { findClip } from "@/editor/doc";
import { useMaskSelection } from "../inspector/inspectorState";
import { useEditStudio, useProject } from "@/editor/store";
import { MaskHandles } from "./MaskHandles";
import { buildCtx } from "./overlayContext";
import { SafeZones } from "./SafeZones";
import { TransformBox } from "./TransformBox";
import styles from "./overlays.module.css";

export interface PreviewOverlaysProps {
  /** The preview canvas (its on-screen box is where overlays draw). */
  canvas: HTMLCanvasElement | null;
  /** Preview size in canvas pixels. */
  width: number;
  height: number;
}

interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

const samePlacement = (a: Placement | null, b: Placement): boolean => !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export function PreviewOverlays({ canvas, width, height }: PreviewOverlaysProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const project = useProject();
  const safeZones = useEditStudio((s) => s.safeZones);
  const playing = useEditStudio((s) => s.playing);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const sources = useEditStudio((s) => s.sources);
  const selection = useEditStudio((s) => s.selection);
  const maskSel = useMaskSelection();

  const measure = useCallback(() => {
    const parent = rootRef.current?.parentElement;
    if (!canvas || !parent) return;
    const c = canvas.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const next = { left: c.left - p.left - parent.clientLeft, top: c.top - p.top - parent.clientTop, width: c.width, height: c.height };
    setPlace((cur) => (samePlacement(cur, next) ? cur : next));
  }, [canvas]);

  useLayoutEffect(() => {
    measure();
    const parent = rootRef.current?.parentElement;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (ro && canvas) ro.observe(canvas);
    if (ro && parent) ro.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, canvas, width, height]);

  const k = place && place.width > 0 ? width / place.width : 1;
  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = canvas?.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
      return { x: ((e.clientX - r.left) * width) / r.width, y: ((e.clientY - r.top) * height) / r.height };
    },
    [canvas, width, height],
  );

  const clip = useMemo(() => {
    if (!project || selection?.kind !== "clips" || selection.ids.length !== 1) return null;
    return findClip(project, selection.ids[0] as string)?.clip ?? null;
  }, [project, selection]);

  // The overlay's clip context: only while the playhead is inside the clip and not playing.
  const ctx = useMemo(() => {
    if (!clip || playing || !place || place.width <= 0) return null;
    if (playheadMs < clip.startMs || playheadMs >= clip.endMs) return null;
    return buildCtx(clip, clip.path ? sources[clip.path] : undefined, { w: width, h: height }, k, playheadMs, toCanvas);
  }, [clip, playing, place, playheadMs, sources, width, height, k, toCanvas]);

  const mask = useMemo(() => {
    if (!clip || maskSel.clipId !== clip.id || !maskSel.maskId) return null;
    return parseMasks(clip.masks).value.find((m) => m.id === maskSel.maskId) ?? null;
  }, [clip, maskSel.clipId, maskSel.maskId]);

  const style = place && place.width > 0 && place.height > 0 ? { left: place.left, top: place.top, width: place.width, height: place.height } : { display: "none" };
  const showZones = safeZones && !!project && (project.aspect === "9:16" || project.aspect === "4:5");

  return (
    <div ref={rootRef} className={styles.root} style={style} data-testid="preview-overlays">
      <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {showZones && project && <SafeZones aspect={project.aspect} width={width} height={height} k={k} />}
        {ctx && clip && clip.kind !== "adjust" && !mask && <TransformBox ctx={ctx} />}
        {ctx && mask && <MaskHandles ctx={ctx} mask={mask} />}
      </svg>
    </div>
  );
}
