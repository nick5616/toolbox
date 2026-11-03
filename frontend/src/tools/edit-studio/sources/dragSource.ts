/**
 * Dragging sources onto the tracks (Phase 9 SPEC §14.6): the Post Builder's
 * pointer-event drag (Wails sees every native HTML5 drag as a file drop) plus
 * a record of whether Shift was held, so the drop can choose "source length"
 * instead of "fill to the next marker".
 */
import { startSourceDrag, useSourceDropTarget, type SourceDropInfo } from "@/tools/post-builder/sourceDrag";

export { useSourceDropTarget };
export type { SourceDropInfo };

let shift = false;

/** Starts a drag of source paths from a pointerdown. */
export function startSourcesDrag(paths: string[], e: { clientX: number; clientY: number; pointerId: number; shiftKey: boolean }): void {
  shift = e.shiftKey;
  const track = (ev: PointerEvent) => {
    shift = ev.shiftKey;
  };
  const stop = () => {
    window.removeEventListener("pointermove", track, true);
    window.removeEventListener("pointerup", track, true);
    window.removeEventListener("pointercancel", stop, true);
  };
  window.addEventListener("pointermove", track, true);
  // The final pointerup updates `shift` before the drop handler runs; listeners go away right after.
  window.addEventListener("pointerup", (ev) => {
    track(ev);
    setTimeout(stop, 0);
  }, { capture: true, once: true });
  window.addEventListener("pointercancel", stop, { capture: true, once: true });
  startSourceDrag(paths, e);
}

/** True when Shift was held at the last pointer event of a source drag. */
export function dragWantsSourceLength(): boolean {
  return shift;
}
