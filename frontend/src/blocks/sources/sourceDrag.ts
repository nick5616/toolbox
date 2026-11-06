import { useEffect, type RefObject } from "react";
import { create } from "zustand";

// Dragging post sources onto slides, a composition or a timeline (SPEC.md
// §B13.4–B13.5). Pointer events, not HTML5 drag-and-drop: Wails' file-drop
// handling sees every native drag.

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

/** Pixels the pointer must move before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

const OVER_ATTR = "data-source-over";

interface Target {
  onDrop: (info: SourceDropInfo) => void;
}

const targets = new Map<HTMLElement, Target>();

interface Session {
  paths: string[];
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  over: HTMLElement | null;
  ghost: HTMLElement | null;
  cleanup: () => void;
}

let session: Session | null = null;

/** The registered target under a point (the innermost one). */
function targetAt(x: number, y: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== "function") return null;
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    if (el instanceof HTMLElement && targets.has(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function setOver(s: Session, el: HTMLElement | null): void {
  if (s.over === el) return;
  s.over?.removeAttribute(OVER_ATTR);
  el?.setAttribute(OVER_ATTR, "");
  s.over = el;
}

function makeGhost(paths: string[]): HTMLElement {
  const g = document.createElement("div");
  g.setAttribute("data-source-ghost", "");
  g.setAttribute("aria-hidden", "true");
  const name = paths[0]?.split(/[\\/]/).pop() ?? "";
  g.textContent = paths.length > 1 ? `${paths.length} sources` : name;
  g.style.cssText =
    "position:fixed;z-index:1000;pointer-events:none;padding:4px 10px;border-radius:12px;" +
    "background:var(--accent);color:var(--accent-fg, #fff);font:12px var(--font-ui, sans-serif);" +
    "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.35);";
  document.body.appendChild(g);
  return g;
}

function moveGhost(s: Session, x: number, y: number): void {
  if (s.ghost) s.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  if (s.ghost) {
    s.ghost.style.left = "0";
    s.ghost.style.top = "0";
  }
}

function end(s: Session): void {
  s.cleanup();
  setOver(s, null);
  s.ghost?.remove();
  s.ghost = null;
  if (session === s) session = null;
  useSourceDrag.setState({ paths: [], x: 0, y: 0 });
}

/** Cancels a drag in progress (Escape does this too). */
export function cancelSourceDrag(): void {
  if (session) end(session);
}

/**
 * Starts a drag of paths from a pointerdown (after a 4 px move threshold);
 * shows a small ghost and calls the drop target under the pointer on release.
 * Escape cancels. A click that follows a drag is swallowed.
 */
export function startSourceDrag(paths: string[], e: { clientX: number; clientY: number; pointerId: number }): void {
  if (paths.length === 0) return;
  cancelSourceDrag();
  const s: Session = {
    paths: [...paths],
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    over: null,
    ghost: null,
    cleanup: () => undefined,
  };
  session = s;

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return;
    if (!s.active) {
      if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) < DRAG_THRESHOLD) return;
      s.active = true;
      s.ghost = makeGhost(s.paths);
    }
    moveGhost(s, ev.clientX, ev.clientY);
    setOver(s, targetAt(ev.clientX, ev.clientY));
    useSourceDrag.setState({ paths: s.paths, x: ev.clientX, y: ev.clientY });
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== s.pointerId) return;
    const wasActive = s.active;
    const target = wasActive ? targetAt(ev.clientX, ev.clientY) : null;
    const paths = s.paths;
    end(s);
    if (wasActive) {
      // The click that ends this gesture must not change the selection.
      const swallow = (c: Event) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (target) targets.get(target)?.onDrop({ paths, x: ev.clientX, y: ev.clientY });
    }
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === s.pointerId) end(s);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      end(s);
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  s.cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
  };
}

/**
 * Makes ref's element a drop target for source drags; onDrop runs when a drag
 * is released over it. While a drag hovers it, the element gets
 * `data-source-over` (style it with CSS).
 */
export function useSourceDropTarget(ref: RefObject<HTMLElement | null>, onDrop: (info: SourceDropInfo) => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    targets.set(el, { onDrop });
    return () => {
      if (targets.get(el)?.onDrop === onDrop) targets.delete(el);
      el.removeAttribute(OVER_ATTR);
    };
  }, [ref, onDrop]);
}
