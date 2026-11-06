/**
 * Autosave of the open edit (Phase 9 SPEC §14.12; Wave 0). Saves 800 ms after
 * the last change, one save in flight; edits made meanwhile trigger one more
 * round. `flushEdit()` saves now (before export, mattes, close, open).
 */
import { useEffect } from "react";
import { EditStudioService, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { NormalProject } from "@/viz/edit/defaults";
import { useEditStudio } from "@/editor/store";

export const AUTOSAVE_MS = 800;

/** Edits being deleted: never save them again on the way out. */
export const discardedEdits = new Set<string>();

let saved: { id: string; name: string; doc: NormalProject } | null = null;
let inflight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(info: ProjectInfo) => void>();

/** Marks the just-opened document as saved (call after store.open). */
export function markOpened(id: string, name: string, doc: NormalProject): void {
  saved = { id, name, doc };
}

function current(): { id: string; name: string; doc: NormalProject } | null {
  const s = useEditStudio.getState();
  return s.projectId && s.history ? { id: s.projectId, name: s.name, doc: s.history.present } : null;
}

function dirty(): boolean {
  const c = current();
  return !!c && (!saved || saved.id !== c.id || saved.doc !== c.doc || saved.name !== c.name);
}

async function saveOnce(): Promise<void> {
  const c = current();
  if (!c || discardedEdits.has(c.id)) return;
  const st = useEditStudio.getState();
  st.setSaveState("saving");
  try {
    const info = await EditStudioService.Save(c.id, c.name, c.doc);
    saved = c;
    const now = current();
    useEditStudio.getState().setSaveState(now && now.doc === c.doc && now.name === c.name ? "saved" : "dirty");
    for (const l of listeners) l(info);
  } catch (e) {
    useEditStudio.getState().setSaveState("error", toAppError(e).message);
    throw e;
  }
}

function run(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      try {
        await saveOnce();
      } catch {
        return;
      }
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Saves now if anything changed, and waits for any save in flight. */
export async function flushEdit(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (dirty()) await run();
  else if (inflight) await inflight;
}

/** Called after every successful save (thumbnails, Sources refetch). Returns an unsubscribe. */
export function onEditSaved(fn: (info: ProjectInfo) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Mount once in the editor: schedules saves on document or name changes and flushes on unmount. */
export function useEditAutosave(): void {
  const doc = useEditStudio((s) => s.history?.present ?? null);
  const name = useEditStudio((s) => s.name);
  useEffect(() => {
    if (!doc || !dirty()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, AUTOSAVE_MS);
  }, [doc, name]);
  useEffect(
    () => () => {
      void flushEdit();
    },
    [],
  );
}
