import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsEmbedded } from "@/lib/embed";

/**
 * For tools with window-level keyboard shortcuts (the eraser's brush keys, the
 * trimmer's playback keys): embedded in another tool, those shortcuts would
 * collide with the host's. `active` is true when the tool isn't embedded, or
 * when the last pointer press / focus landed inside `ref`'s element. Use it in
 * `useShortcut(..., { when: active && ... })`.
 */
export function useEmbedFocus<T extends HTMLElement = HTMLElement>(): { ref: RefObject<T | null>; active: boolean } {
  const embedded = useIsEmbedded();
  const ref = useRef<T>(null);
  const [inside, setInside] = useState(false);
  useEffect(() => {
    if (!embedded) return;
    const on = (e: Event) => setInside(!!ref.current && e.target instanceof Node && ref.current.contains(e.target));
    document.addEventListener("pointerdown", on, true);
    document.addEventListener("focusin", on, true);
    return () => {
      document.removeEventListener("pointerdown", on, true);
      document.removeEventListener("focusin", on, true);
    };
  }, [embedded]);
  return { ref, active: !embedded || inside };
}
