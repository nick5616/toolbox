/** Viewport media queries as React state (layouts that change shape on small windows). */
import { useSyncExternalStore } from "react";

/** The sidebar becomes an icon rail below this window width (the tools keep ~900 px). */
export const NARROW_QUERY = "(max-width: 1179px)";

function query(q: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q) : null;
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = query(q);
      if (!mq) return () => undefined;
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => query(q)?.matches ?? false,
    () => false,
  );
}

export function matchesNow(q: string): boolean {
  return query(q)?.matches ?? false;
}

/** Short windows: strips and headers give their height to the work area. */
export const SHORT_QUERY = "(max-height: 759px)";
