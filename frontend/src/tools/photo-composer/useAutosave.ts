import { useCallback, useEffect, useRef, useState } from "react";
import { ComposerService, type Composition, type ProjectInfo } from "@/lib/api";
import { exportComposition } from "@/composer/export";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export const AUTOSAVE_MS = 800;

/** Projects being deleted: their editors must not save again on the way out. */
export const discardedProjects = new Set<string>();

export interface AutosaveOptions {
  projectId: string;
  name: string;
  doc: Composition;
  /** Called after each successful Save; first = the first success of this editor session. */
  onSaved?: (info: ProjectInfo, first: boolean) => void;
  delayMs?: number;
}

export interface Autosave {
  state: SaveState;
  /** Saves now (when dirty, or always with force) and waits for it, including the render. */
  flush: (force?: boolean) => Promise<void>;
}

/**
 * Saves the document 800 ms after the last change, then re-renders it at 1x
 * for the project's thumbnail/export (SaveRender). One save (plus its render)
 * is in flight at a time; edits made meanwhile trigger one more round.
 */
export function useAutosave(opts: AutosaveOptions): Autosave {
  const { projectId, name, doc } = opts;
  const delay = opts.delayMs ?? AUTOSAVE_MS;
  const [state, setState] = useState<SaveState>("idle");
  const latest = useRef({ name, doc });
  latest.current = { name, doc };
  const saved = useRef<{ name: string; doc: Composition }>({ name, doc });
  const onSaved = useRef(opts.onSaved);
  onSaved.current = opts.onSaved;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const failed = useRef(false);
  const firstDone = useRef(false);
  const mounted = useRef(true);
  const idRef = useRef(projectId);
  idRef.current = projectId;

  const set = useCallback((s: SaveState) => {
    if (mounted.current) setState(s);
  }, []);

  const saveOnce = useCallback(async () => {
    const { name: n, doc: d } = latest.current;
    const id = idRef.current;
    if (discardedProjects.has(id)) return;
    set("saving");
    try {
      const info = await ComposerService.Save(id, n, d);
      saved.current = { name: n, doc: d };
      failed.current = false;
      const first = !firstDone.current;
      firstDone.current = true;
      set(latest.current.doc === d && latest.current.name === n ? "saved" : "dirty");
      onSaved.current?.(info, first);
    } catch {
      failed.current = true;
      set("error");
      return;
    }
    try {
      await exportComposition(id, d, 1);
    } catch {
      // The render is a convenience (thumbnail, export); the document itself is saved.
    }
  }, [set]);

  const run = useCallback((): Promise<void> => {
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const p = (async () => {
      do {
        again.current = false;
        await saveOnce();
      } while (again.current && !failed.current);
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [saveOnce]);

  const isDirty = (): boolean => latest.current.doc !== saved.current.doc || latest.current.name !== saved.current.name;

  useEffect(() => {
    if (!isDirty()) return;
    set("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void run();
    }, delay);
  }, [doc, name, delay, run, set]);

  const flush = useCallback(
    async (force = false) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (isDirty() || force) await run();
      else if (inflight.current) await inflight.current;
    },
    [run],
  );

  // Leaving the view: save what is pending.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (isDirty()) void run();
    };
  }, [run]);

  return { state, flush };
}
