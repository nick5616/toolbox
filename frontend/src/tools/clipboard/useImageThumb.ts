import { useEffect, useState, type RefObject } from "react";
import { ClipboardService } from "@/lib/api";

const MAX_CACHE = 300;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Loads (once per id) the data URL of an image item. */
export function loadThumb(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    p = ClipboardService.ImageDataURL(id)
      .then((url) => {
        cache.set(id, url);
        if (cache.size > MAX_CACHE) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return url;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export function clearThumbCache(): void {
  cache.clear();
  inflight.clear();
}

/** True once the element has scrolled into view (immediately without IntersectionObserver). */
function useVisible(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!enabled || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, visible]);
  return visible;
}

export type ThumbState = { url: string | null; failed: boolean };

/** Lazy, cached thumbnail for image item `id`; loads only when the element is visible. */
export function useImageThumb(id: string, ref: RefObject<Element | null>, enabled: boolean): ThumbState {
  const visible = useVisible(ref, enabled);
  const [state, setState] = useState<ThumbState>(() => ({ url: cache.get(id) ?? null, failed: false }));
  useEffect(() => {
    if (!enabled || !visible) return;
    let live = true;
    loadThumb(id).then(
      (url) => live && setState({ url, failed: false }),
      () => live && setState({ url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [id, enabled, visible]);
  return state;
}
