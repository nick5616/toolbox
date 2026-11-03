/**
 * A horizontal scrollbar for the timeline (the lanes and tracks share
 * pps/scrollMs, so one bar moves both). Drag the thumb, or click the bar to
 * jump there. Hidden when the whole edit fits.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { HEADER_PX } from "../geometry";
import { useEditStudio } from "../store";
import styles from "./TimeScrollbar.module.css";

export function thumbGeometry(barPx: number, durationMs: number, pps: number, scrollMs: number, timePx: number): { left: number; width: number; visible: boolean } {
  const visibleMs = (timePx * 1000) / pps;
  if (durationMs <= 0 || barPx <= 0 || visibleMs >= durationMs) return { left: 0, width: barPx, visible: false };
  const width = Math.max(24, (visibleMs / durationMs) * barPx);
  const maxScroll = durationMs - visibleMs;
  const left = maxScroll > 0 ? (Math.min(scrollMs, maxScroll) / maxScroll) * (barPx - width) : 0;
  return { left, width, visible: true };
}

export function TimeScrollbar({ width, durationMs }: { width: number; durationMs: number }) {
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const barPx = Math.max(0, width - HEADER_PX - 8);
  const g = thumbGeometry(barPx, durationMs, pps, scrollMs, width - HEADER_PX);
  const drag = useRef<{ x: number; left: number } | null>(null);
  if (!g.visible) return null;

  const scrollTo = (left: number) => {
    const st = useEditStudio.getState();
    const visibleMs = ((width - HEADER_PX) * 1000) / st.pps;
    const maxScroll = Math.max(0, durationMs - visibleMs);
    const frac = barPx - g.width > 0 ? Math.max(0, Math.min(1, left / (barPx - g.width))) : 0;
    st.setView(st.pps, frac * maxScroll);
  };
  const onBar = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    scrollTo(e.clientX - r.left - g.width / 2);
  };
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, left: g.left };
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) scrollTo(d.left + e.clientX - d.x);
  };
  const onThumbUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div className={styles.wrap} style={{ paddingLeft: HEADER_PX + 4 }}>
      <div className={styles.bar} style={{ width: barPx }} onPointerDown={onBar} role="scrollbar" aria-orientation="horizontal" aria-label="Scroll the timeline" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((g.left / Math.max(1, barPx - g.width)) * 100)} aria-controls="es-tracks">
        <div className={styles.thumb} style={{ left: g.left, width: g.width }} onPointerDown={onThumbDown} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp} />
      </div>
    </div>
  );
}
