import { useEffect, useState, type RefObject } from "react";
import { loadPdfThumb } from "./thumbs";

/** True once the element has been on screen (always true without IntersectionObserver). */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/** Loads a PDF page thumbnail once `enabled`; returns the data URL, or "" while loading / on failure. */
export function usePdfThumb(path: string, page: number, width: number, password: string, enabled: boolean): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadPdfThumb(path, page, width, password).then(
      (url) => !cancelled && setSrc(url),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [path, page, width, password, enabled]);
  return src;
}
