/**
 * Before-pop-out flushers (Phase 10, SPEC.md §4.3). A tool whose state lives
 * in memory (the editor's document) registers an async function that saves
 * it; the shell awaits those (at most 3 s) before opening the tool's window,
 * so the new window reopens the saved state.
 */
import { useEffect, useRef } from "react";
import { toast } from "@/components/toast";
import { toAppError } from "@/lib/errors";
import { popOutTool } from "@/lib/windows";

type Flusher = () => Promise<void> | void;

const flushers = new Map<string, Set<{ current: Flusher }>>();

/** The longest the shell waits for flushers before popping out anyway. */
export const POP_OUT_FLUSH_MS = 3000;

/** Registers `fn` to run before this module's tool pops out (while the component is mounted). */
export function useBeforePopOut(moduleId: string, fn: Flusher): void {
  const ref = useRef<Flusher>(fn);
  ref.current = fn;
  useEffect(() => {
    let set = flushers.get(moduleId);
    if (!set) {
      set = new Set();
      flushers.set(moduleId, set);
    }
    const entry = ref;
    set.add(entry);
    return () => {
      const s = flushers.get(moduleId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) flushers.delete(moduleId);
    };
  }, [moduleId]);
}

/** Runs every flusher registered for the module; resolves when all finish or after 3 s. Errors are swallowed. */
export async function runBeforePopOut(moduleId: string): Promise<void> {
  const set = flushers.get(moduleId);
  if (!set || set.size === 0) return;
  const all = Promise.all(
    [...set].map(async (f) => {
      try {
        await f.current();
      } catch {
        /* a failing flusher must not block the pop-out */
      }
    }),
  ).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POP_OUT_FLUSH_MS);
  });
  try {
    await Promise.race([all, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Flushes the tool, then opens it in its own window; failures toast. */
export async function popOutToolFlushed(moduleId: string, name: string): Promise<void> {
  try {
    await runBeforePopOut(moduleId);
    await popOutTool(moduleId, { title: `${name} — Toolbox` });
  } catch (e) {
    toast({ tone: "danger", title: toAppError(e).message });
  }
}
