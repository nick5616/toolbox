import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Analysis } from "@/viz/analysis";
import type { Signals } from "@/viz/signals";

/** What the designer's panels share: the analysis, its signals and the playhead (updated 4 times a second). */
export interface DesignerContextValue {
  analysis: Analysis;
  signals: Signals;
  /** The playhead, throttled for live readouts (meters, Why). */
  liveMs: number;
}

export const DesignerContext = createContext<DesignerContextValue | null>(null);

export function useDesigner(): DesignerContextValue | null {
  return useContext(DesignerContext);
}

/** `value`, but it changes at most once per `ms` (trailing edge kept). */
export function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const wait = Math.max(0, last.current + ms - now);
    if (wait === 0) {
      last.current = now;
      setOut(value);
      return;
    }
    const t = setTimeout(() => {
      last.current = Date.now();
      setOut(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}
