/**
 * Scrubbing: drag the playhead (its grip in the lanes and tracks) or any
 * seek surface, and the playhead follows the pointer, audio included.
 * Seeks are coalesced to one per animation frame.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { xToMs } from "../geometry";
import { useEditStudio } from "../store";
import { seekTo } from "../transport/player";

/**
 * Starts a scrub from a pointerdown. `timeLeft()` returns the client x of the
 * time area's 0 (after the row headers); `durationMs` clamps.
 */
export function startScrub(e: ReactPointerEvent<HTMLElement> | PointerEvent, timeLeft: () => number, durationMs: number): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  let pending: number | null = null;
  let raf = 0;
  const at = (clientX: number) => {
    const s = useEditStudio.getState();
    return Math.max(0, Math.min(durationMs, xToMs(clientX - timeLeft(), s.pps, s.scrollMs)));
  };
  const flush = () => {
    raf = 0;
    if (pending !== null) seekTo(pending);
    pending = null;
  };
  const queue = (ms: number) => {
    pending = ms;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  queue(at(e.clientX));
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = "ew-resize";
  const move = (ev: PointerEvent) => queue(at(ev.clientX));
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.style.cursor = prevCursor;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ev.type === "pointerup") seekTo(at(ev.clientX));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
