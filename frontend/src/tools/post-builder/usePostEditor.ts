import { useCallback, useEffect, useRef, useState } from "react";
import { PostsService, type PostIssue, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { docForSave, normalizePost, type PostDoc } from "./logic";

export const AUTOSAVE_MS = 800;
export const CHECK_MS = 300;

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface PostEditor {
  doc: PostDoc | null;
  name: string;
  loading: boolean;
  loadError: string;
  /** The id of the post `doc` belongs to (empty while another one loads). */
  loadedId: string;
  issues: PostIssue[];
  saveState: SaveState;
  /** Changes the post; autosaves after AUTOSAVE_MS. */
  update: (fn: (d: PostDoc) => PostDoc) => void;
  rename: (name: string) => void;
  /** Saves now if there are unsaved edits. */
  flush: () => Promise<void>;
  /** Reloads the post from disk (after an editor linked a project). */
  reload: () => Promise<void>;
}

/**
 * Loads one post and keeps it saved: edits autosave 800 ms after the last one,
 * the checks list refreshes 300 ms after it, and leaving flushes.
 */
export function usePostEditor(postId: string, onSaved: (info: ProjectInfo) => void): PostEditor {
  const [doc, setDoc] = useState<PostDoc | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [issues, setIssues] = useState<PostIssue[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const ref = useRef({ id: "", doc: null as PostDoc | null, name: "", dirty: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const save = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const cur = ref.current;
    if (!cur.dirty || !cur.doc || !cur.id) return inflight.current;
    cur.dirty = false;
    const { id, doc: d, name: n } = cur;
    setSaveState("saving");
    const run = inflight.current
      .catch(() => undefined)
      .then(() => PostsService.Save(id, n, docForSave(d)))
      .then((info) => {
        onSavedRef.current(info);
        if (ref.current.id === id) setSaveState(ref.current.dirty ? "dirty" : "saved");
      })
      .catch((e) => {
        if (ref.current.id === id) {
          ref.current.dirty = true;
          setSaveState("error");
        }
        throw e;
      });
    inflight.current = run.catch(() => undefined);
    return run;
  }, []);

  const schedule = useCallback(() => {
    ref.current.dirty = true;
    setSaveState("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save().catch(() => undefined), AUTOSAVE_MS);
  }, [save]);

  const load = useCallback(async (id: string, silent: boolean) => {
    if (!id) return;
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const [post, list] = await Promise.all([PostsService.Get(id), PostsService.List()]);
      if (ref.current.id !== id) return;
      const d = normalizePost(post);
      const info = (list ?? []).find((p) => p.id === id);
      ref.current.doc = d;
      ref.current.name = info?.name ?? ref.current.name;
      ref.current.dirty = false;
      setDoc(d);
      setName(ref.current.name);
      setLoadedId(id);
      setSaveState("saved");
    } catch (e) {
      if (ref.current.id === id) setLoadError(toAppError(e).message);
    } finally {
      if (ref.current.id === id) setLoading(false);
    }
  }, []);

  // Switching posts: save the old one first, then load the new one.
  useEffect(() => {
    const prevId = ref.current.id;
    let cancelled = false;
    void (async () => {
      if (prevId && prevId !== postId) await save().catch(() => undefined);
      if (cancelled) return;
      ref.current = { id: postId, doc: null, name: "", dirty: false };
      setDoc(null);
      setLoadedId("");
      setName("");
      setIssues([]);
      setSaveState("saved");
      if (postId) await load(postId, false);
    })();
    return () => {
      cancelled = true;
    };
  }, [postId, load, save]);

  // Leaving the tool flushes.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void save().catch(() => undefined);
    },
    [save],
  );

  // Checks, debounced.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const t = setTimeout(() => {
      PostsService.Check(docForSave(doc))
        .then((r) => !cancelled && setIssues(r ?? []))
        .catch(() => undefined);
    }, CHECK_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [doc]);

  const update = useCallback(
    (fn: (d: PostDoc) => PostDoc) => {
      const cur = ref.current.doc;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      ref.current.doc = next;
      setDoc(next);
      schedule();
    },
    [schedule],
  );

  const rename = useCallback(
    (n: string) => {
      ref.current.name = n;
      setName(n);
      schedule();
    },
    [schedule],
  );

  const flush = useCallback(() => save(), [save]);
  const reload = useCallback(async () => {
    await save().catch(() => undefined);
    await load(ref.current.id, true);
  }, [save, load]);

  return { doc, loadedId, name, loading, loadError, issues, saveState, update, rename, flush, reload };
}
