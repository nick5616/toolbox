/**
 * The Color Grader's preview (Phase 21 SPEC §E1, §E3.2): a one-clip
 * `EditEngine` through the editor's `EditCanvas`, with a before/after split
 * you drag (`\` toggles it) and a mini transport for video. It reads only the
 * store, so it renders the same popped out in its own window.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Badge, Button, EmptyState, IconButton, Slider, Spinner } from "@/components";
import { formatTimecode } from "@/lib/format";
import { useElementSize } from "@/lib/useElementSize";
import { useShortcut } from "@/lib/shortcuts";
import { EditCanvas } from "@/viz/edit/EditCanvas";
import { fitSize, sourceSize, useGradeInputs } from "./previewInputs";
import { useGrade } from "./store";
import styles from "./Grade.module.css";

const MAX_LONG = 1600;

/** The `\` shortcut and the transport clock; mount once in the window that hosts the store. */
export function useGradeClock(): void {
  const playing = useGrade((s) => s.playing);
  const duration = useGrade((s) => (s.src?.info.kind === "video" ? s.src.info.durationMs : 0));
  useShortcut("Backslash", () => useGrade.getState().setCompare(!useGrade.getState().compare), { when: true });
  useEffect(() => {
    if (!playing || duration <= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const t = useGrade.getState().timeMs + dt;
      useGrade.getState().setTime(t >= duration ? 0 : t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);
}

function Transport() {
  const timeMs = useGrade((s) => s.timeMs);
  const playing = useGrade((s) => s.playing);
  const duration = useGrade((s) => s.src?.info.durationMs ?? 0);
  const setTime = useGrade((s) => s.setTime);
  const setPlaying = useGrade((s) => s.setPlaying);
  return (
    <div className={styles.transport} role="group" aria-label="Playback">
      <IconButton label={playing ? "Pause" : "Play"} icon={playing ? "pause" : "play"} size="sm" kbd="Space" onClick={() => setPlaying(!playing)} />
      <Slider value={Math.min(timeMs, duration)} min={0} max={Math.max(1, duration)} step={10} onChange={setTime} aria-label="Position in the video" data-tip="Move through the video" format={(v) => formatTimecode(v / 1000)} />
    </div>
  );
}

/** The draggable before/after divider over the preview. */
function Divider() {
  const pos = useGrade((s) => s.comparePos);
  const setPos = useGrade((s) => s.setComparePos);
  const drag = useRef<{ left: number; width: number } | null>(null);
  const move = (clientX: number) => {
    const d = drag.current;
    if (d && d.width > 0) setPos((clientX - d.left) / d.width);
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    drag.current = { left: box.left, width: box.width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    move(e.clientX);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setPos(pos - 0.02);
    else if (e.key === "ArrowRight") setPos(pos + 0.02);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={styles.divider}
      style={{ left: `${pos * 100}%` } as CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label="Before and after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos * 100)}
      data-tip="Drag to compare: the original on the left, your look on the right"
      onPointerDown={down}
      onPointerMove={(e) => drag.current && move(e.clientX)}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={key}
    >
      <span className={styles.dividerGrip} />
    </div>
  );
}

export function GradePreview() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const area = useElementSize(box);
  const src = useGrade((s) => s.src);
  const selected = useGrade((s) => s.selected);
  const prepareJob = useGrade((s) => s.prepareJob);
  const compare = useGrade((s) => s.compare);
  const pos = useGrade((s) => s.comparePos);
  const timeMs = useGrade((s) => s.timeMs);
  const playing = useGrade((s) => s.playing);
  const mapView = useGrade((s) => s.mapView);
  const setCompare = useGrade((s) => s.setCompare);
  const setMapView = useGrade((s) => s.setMapView);
  const isVideo = src?.info.kind === "video";

  const source = useMemo(() => sourceSize(src), [src]);
  const size = useMemo(() => fitSize(source, { width: Math.max(2, area.width), height: Math.max(2, area.height) }, MAX_LONG), [source, area.width, area.height]);
  const graded = useGradeInputs(size, { graded: true });
  const original = useGradeInputs(size, { graded: false });
  const onCanvas = useCallback(() => undefined, []);

  if (!selected) {
    return (
      <div className={styles.previewEmpty}>
        <EmptyState icon="palette" size="lg" title="Color Grader" body="Film looks to absolutely unhinged. Drop a picture or a video here." />
      </div>
    );
  }
  const waiting = !graded;
  const failed = src?.error ?? "";
  const cssSize = { width: area.width > 0 ? size.width * Math.min(1, area.width / size.width, area.height / size.height) : size.width, height: 0 };
  cssSize.height = (cssSize.width * size.height) / size.width;

  return (
    <div className={styles.previewRoot}>
      <div className={styles.previewArea} ref={setBox}>
        <div className={styles.frame} style={{ width: cssSize.width, height: cssSize.height }} data-testid="grade-frame">
          {graded && <EditCanvas inputs={graded} width={size.width} height={size.height} timeMs={timeMs} playing={playing} quality={playing ? "draft" : "full"} onCanvas={onCanvas} />}
          {compare && original && !mapView && (
            <div className={styles.before} style={{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }} aria-hidden>
              <EditCanvas inputs={original} width={size.width} height={size.height} timeMs={timeMs} playing={playing} quality={playing ? "draft" : "full"} />
            </div>
          )}
          {compare && !mapView && graded && <Divider />}
          {compare && !mapView && graded && (
            <>
              <span className={styles.tagBefore}>Before</span>
              <span className={styles.tagAfter}>After</span>
            </>
          )}
          {waiting && !failed && (
            <div className={styles.preparing} role="status">
              <Spinner /> {prepareJob || src?.preparing ? "Preparing the preview…" : "Opening…"}
            </div>
          )}
          {failed && <div className={styles.preparing}>{failed}</div>}
        </div>
        {mapView && (
          <div className={styles.mapBanner}>
            <Badge tone="accent">Showing the {mapView === "depth" ? "depth" : mapView} map</Badge>
            <Button size="sm" variant="secondary" data-tip="Go back to your picture with the look" onClick={() => setMapView("")}>
              Back to the picture
            </Button>
          </div>
        )}
        <div className={styles.previewTools}>
          <IconButton
            label={compare ? "Hide before and after" : "Before and after"}
            icon="columns-2"
            size="sm"
            variant="secondary"
            kbd="\"
            pressed={compare}
            aria-disabled={!graded || undefined}
            onClick={() => graded && setCompare(!compare)}
          />
        </div>
        {isVideo && graded && <Transport />}
      </div>
    </div>
  );
}
