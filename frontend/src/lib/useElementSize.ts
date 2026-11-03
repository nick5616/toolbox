/** An element's content-box size, kept current with a ResizeObserver (layouts that adapt to their container). */
import { useEffect, useState } from "react";

export interface Size {
  width: number;
  height: number;
}

export function useElementSize(el: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const read = () => setSize((cur) => (cur.width === el.clientWidth && cur.height === el.clientHeight ? cur : { width: el.clientWidth, height: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}
