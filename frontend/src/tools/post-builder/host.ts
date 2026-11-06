/**
 * The host window's side of Post Builder (Phase 11, SPEC §5.2): loading, the
 * checks, the selection, the handoffs and the refresh after an editing window
 * closes. Autosave lives in the store. Mounted once by the tool view; part
 * windows (replicas) never run it.
 */
import { useCallback, useEffect, useRef } from "react";
import { toast } from "@/components";
import { FilesService, PostsService } from "@/lib/api";
import { useToolHandoff } from "@/lib/embed";
import { useWindows } from "@/state/windows";
import type { Handoff } from "@/state/ui";
import { addExtras, folderBaseName } from "./pool";
import { MEDIA_EXTS as SOURCE_EXTS } from "./SourcesPanel";
import { defaultPostName, docForSave, editWindowClosed } from "./logic";
import { CHECK_MS, isEditingElsewhere, setEditingElsewhere, usePostBuilder, useRecordedDoc } from "./postStore";
import { NEW_POST, useAddToPost, usePostDrop } from "./store";

export function usePostHost(): void {
  const st = usePostBuilder.getState;
  const ready = usePostBuilder((s) => s.ready);
  const postId = usePostBuilder((s) => s.postId);
  const selectedId = usePostBuilder((s) => s.selectedId);
  const lastPostId = usePostBuilder((s) => s.pstate.lastPostId);
  const doc = useRecordedDoc();

  // Load on mount; leaving the tool saves but keeps the open post and its undo history, so coming
  // back (from an editing tool, a pop-out) reloads the post from disk and undo still works.
  useEffect(() => {
    if (st().history) usePostBuilder.setState({ ready: false });
    else st().reset();
    void st().init();
    return () => {
      void st().save().catch(() => undefined);
    };
  }, [st]);

  // Remember the open post.
  useEffect(() => {
    if (ready && postId && lastPostId !== postId) st().persist({ ...st().pstate, lastPostId: postId });
  }, [ready, postId, lastPostId, st]);

  // Keep a selection.
  useEffect(() => {
    st().ensureSelection();
  }, [doc, selectedId, st]);

  // Checks, debounced.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const t = setTimeout(() => {
      PostsService.Check(docForSave(doc))
        .then((r) => !cancelled && st().setIssues(r ?? []))
        .catch(() => undefined);
    }, CHECK_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [doc, st]);

  // ---- handoffs ----
  const pendingAdd = useRef<{ postId: string; paths: string[]; extra?: boolean } | null>(null);

  const drainPending = useCallback(() => {
    const p = pendingAdd.current;
    const s = st();
    if (!p || p.postId !== s.postId || s.loadedId !== s.postId || !s.history) return;
    pendingAdd.current = null;
    if (p.extra) s.edit((d) => ({ ...d, extra: addExtras(d.extra, p.paths) }));
    else void s.addPaths(p.paths);
  }, [st]);

  const applyHandoff = useCallback(
    async (h: Handoff) => {
      const s = st();
      if (h.postSlide) {
        const ps = h.postSlide;
        s.setPendingSelect(ps.slideId);
        void s.refreshProjects();
        if (ps.postId === s.postId) await s.reload();
        else await s.openPost(ps.postId);
        return;
      }
      if (h.inputs.length === 0) return;
      const dropped = usePostDrop.getState().take();
      // Folders (from a drop) make a post; the files dropped with them become its extra sources.
      const infos = (await FilesService.Stat(h.inputs).catch(() => null)) ?? [];
      const dirs = infos.filter((i) => i.isDir).map((i) => i.path);
      if (dirs.length > 0) {
        const folder = dirs[0]!;
        const files = h.inputs.filter((p) => !dirs.includes(p));
        if (dirs.length > 1) toast({ title: "Made a post from the first folder", description: "Drop the others one at a time." });
        const id = await st().createFromFolder(folderBaseName(folder) || defaultPostName("carousel"), "carousel", "4:5", folder, false);
        if (id && files.length > 0) {
          pendingAdd.current = { postId: id, paths: files, extra: true };
          drainPending();
        }
        return;
      }
      const target = useAddToPost.getState().takeTarget();
      const cur = st();
      if (dropped && !target) {
        const files = h.inputs.filter((p) => SOURCE_EXTS.some((x) => p.toLowerCase().endsWith(x)));
        if (files.length === 0) return;
        if (cur.history && cur.loadedId === cur.postId) {
          cur.edit((d) => ({ ...d, extra: addExtras(d.extra, files) }));
        } else if (cur.postId) {
          pendingAdd.current = { postId: cur.postId, paths: files, extra: true };
        } else {
          const id = await st().createPost(defaultPostName("carousel"), "carousel", "4:5", []);
          if (id) {
            pendingAdd.current = { postId: id, paths: files, extra: true };
            drainPending();
          }
        }
        return;
      }
      if (target === NEW_POST || (!target && !cur.postId)) {
        await st().createPost(defaultPostName("carousel"), "carousel", "4:5", h.inputs);
      } else if (target && target !== cur.postId) {
        pendingAdd.current = { postId: target, paths: h.inputs };
        await st().openPost(target);
        drainPending();
      } else if (cur.history && cur.loadedId === cur.postId) {
        await cur.addPaths(h.inputs);
      } else {
        pendingAdd.current = { postId: cur.postId, paths: h.inputs };
      }
    },
    [st, drainPending],
  );

  // A handoff that arrives before the posts are loaded waits for them.
  const queued = useRef<Handoff[]>([]);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useToolHandoff("post-builder", (h) => {
    if (readyRef.current) void applyHandoff(h);
    else queued.current.push(h);
  });
  useEffect(() => {
    if (!ready) return;
    const q = queued.current;
    queued.current = [];
    for (const h of q) void applyHandoff(h);
  }, [ready, applyHandoff]);

  // Files waiting for their post to finish loading.
  useEffect(() => {
    drainPending();
  }, [doc, postId, drainPending]);

  // ---- edited in another window: pick the changes up when it closes, and when this one is focused again ----
  const refreshFromDisk = useCallback(async () => {
    const s = st();
    try {
      await s.flush();
      await s.refreshProjects();
      await s.reload();
    } catch {
      // The next focus tries again.
    }
  }, [st]);
  useEffect(() => {
    let prev = useWindows.getState().open;
    return useWindows.subscribe((w) => {
      const closed = editWindowClosed(prev, w.open);
      prev = w.open;
      if (closed) {
        setEditingElsewhere(false);
        void refreshFromDisk();
      }
    });
  }, [refreshFromDisk]);
  useEffect(() => {
    const onFocus = () => {
      if (isEditingElsewhere()) void refreshFromDisk();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFromDisk]);
}
