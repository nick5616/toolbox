/**
 * Middle-button drag (the wheel pressed) scrolls a native scroll container
 * in both directions, and stops the browser's autoscroll on that button.
 * `onPan` replaces the native scrolling for views that keep their own offset.
 */
import { useEffect } from "react";

export function useMiddleDragScroll(el: HTMLElement | null, onPan?: (dx: number, dy: number) => void): void {
  useEffect(() => {
    if (!el) return;
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (onPan) {
        onPan(dx, dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
      } else {
        el.scrollLeft = drag.left - dx;
        el.scrollTop = drag.top - dy;
      }
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.style.cursor = "";
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const noAuto = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("mousedown", noAuto);
    el.addEventListener("auxclick", noAuto);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("mousedown", noAuto);
      el.removeEventListener("auxclick", noAuto);
    };
  }, [el, onPan]);
}
