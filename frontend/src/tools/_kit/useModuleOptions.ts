import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsService } from "@/lib/api";

const SAVE_DEBOUNCE_MS = 300;

/**
 * Loads a module's saved options (SettingsService.ModuleState) merged over
 * `defaults` via `sanitize`, and saves changes debounced 300 ms.
 * Returns [options, setOptions, loaded].
 */
export function useModuleOptions<T>(
  moduleId: string,
  defaults: T,
  sanitize: (saved: unknown, defaults: T) => T,
): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const [opts, setOpts] = useState<T>(defaults);
  const [loaded, setLoaded] = useState(false);
  const dirty = useRef(false);
  const defaultsRef = useRef(defaults);
  const sanitizeRef = useRef(sanitize);
  defaultsRef.current = defaults;
  sanitizeRef.current = sanitize;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next = defaultsRef.current;
      try {
        const saved = await SettingsService.ModuleState(moduleId);
        if (saved) next = sanitizeRef.current(JSON.parse(saved) as unknown, defaultsRef.current);
      } catch {
        /* unreadable state: use defaults */
      }
      if (cancelled) return;
      // Don't clobber edits made before the load finished.
      if (!dirty.current) setOpts(next);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      SettingsService.SetModuleState(moduleId, JSON.stringify(opts)).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [opts, moduleId]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    dirty.current = true;
    setOpts(next);
  }, []);

  return [opts, set, loaded];
}
