import { useEffect, type RefObject } from "react";
import { create } from "zustand";

// Dragging post sources onto slides, a composition or a timeline (SPEC.md
// §B13.4–B13.5). FROZEN API (Wave C0); WP-PB3 implements the drag itself.
// Pointer events, not HTML5 drag-and-drop: Wails' file-drop handling sees
// every native drag.

export interface SourceDragState {
  /** Paths being dragged ([] = no drag). */
  paths: string[];
  /** Pointer position (client px) while dragging. */
  x: number;
  y: number;
}

export const useSourceDrag = create<SourceDragState>(() => ({ paths: [], x: 0, y: 0 }));

/** Where a drop landed, for the target's handler. */
export interface SourceDropInfo {
  paths: string[];
  /** Pointer position (client px) at the drop. */
  x: number;
  y: number;
}

/**
 * Starts a drag of paths from a pointerdown (after a 4 px move threshold);
 * shows a small ghost and calls the drop target under the pointer on release.
 * STUB (Wave C0): does nothing yet.
 */
export function startSourceDrag(paths: string[], e: { clientX: number; clientY: number; pointerId: number }): void {
  void paths;
  void e;
}

/**
 * Makes ref's element a drop target for source drags; onDrop runs when a drag
 * is released over it. While a drag hovers it, the element gets
 * `data-source-over` (style it with CSS). STUB (Wave C0): never fires.
 */
export function useSourceDropTarget(ref: RefObject<HTMLElement | null>, onDrop: (info: SourceDropInfo) => void): void {
  useEffect(() => {
    void ref;
    void onDrop;
  }, [ref, onDrop]);
}
