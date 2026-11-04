/**
 * Loads what the open edit needs besides its document (Phase 9 SPEC §14.12;
 * Wave 0): the song's analysis (from analysisKey), source states and matte
 * states. Packages refresh sources/mattes themselves after their jobs, with
 * refreshSources / refreshMattes.
 */
import { useEffect } from "react";
import { EditStudioService, MediaService, type AnalysisRef, type EditMatteState } from "@/lib/api";
import { loadAnalysis, type Analysis } from "@/viz/analysis";
import { useEditStudio } from "@/editor/store";
import { isReplicaWindow } from "./bridge";

const cache = new Map<string, Promise<Analysis>>();

/** Loads an analysis ref's files (cached per key). */
export function loadRef(ref: AnalysisRef): Promise<Analysis> {
  let p = cache.get(ref.key);
  if (!p) {
    p = (async () => {
      const [audioJsonUrl, featuresUrl, textJsonUrl] = await Promise.all([
        MediaService.URLFor(ref.audioJson),
        MediaService.URLFor(ref.featuresPath),
        ref.textJson ? MediaService.URLFor(ref.textJson) : Promise.resolve(""),
      ]);
      return loadAnalysis({ audioJsonUrl, featuresUrl, textJsonUrl: textJsonUrl || undefined });
    })();
    p.catch(() => cache.delete(ref.key));
    cache.set(ref.key, p);
  }
  return p;
}

/** Loads analysis `key` into the store (state "missing" when it isn't cached any more). */
export async function useAnalysisKey(key: string): Promise<void> {
  const st = useEditStudio.getState();
  if (!key) {
    st.setAnalysis(null, null, "none");
    return;
  }
  if (st.analysisRef?.key === key && st.analysis) return;
  st.setAnalysis(null, null, "loading");
  let ref: AnalysisRef;
  try {
    ref = await EditStudioService.Analysis(key);
  } catch {
    if (useEditStudio.getState().history?.present.analysisKey === key) useEditStudio.getState().setAnalysis(null, null, "missing");
    return;
  }
  try {
    const a = await loadRef(ref);
    if (useEditStudio.getState().history?.present.analysisKey === key) useEditStudio.getState().setAnalysis(ref, a, "ready");
  } catch {
    if (useEditStudio.getState().history?.present.analysisKey === key) useEditStudio.getState().setAnalysis(null, null, "error");
  }
}

/** Re-reads the state of source files at the project's fps. */
export async function refreshSources(paths?: string[]): Promise<void> {
  if (isReplicaWindow()) return; // replicas get source states from the host
  const p = useEditStudio.getState().history?.present;
  if (!p) return;
  const list = paths ?? [...new Set([...p.sources.map((s) => s.path), ...p.tracks.flatMap((t) => t.clips.map((c) => c.path).filter(Boolean))])];
  if (!list.length) return;
  try {
    const states = await EditStudioService.Sources(list, p.fps);
    useEditStudio.getState().setSources(states ?? []);
  } catch {
    // shown as "not prepared" until the next refresh
  }
}

/** Re-reads the state of the open edit's mattes. */
export async function refreshMattes(ids?: string[]): Promise<void> {
  if (isReplicaWindow()) return;
  const s = useEditStudio.getState();
  const p = s.history?.present;
  if (!p || !s.projectId) return;
  const list = ids ?? p.tracks.flatMap((t) => t.clips.map((c) => c.matte?.id ?? "").filter(Boolean));
  if (!list.length) return;
  try {
    const states = await EditStudioService.Mattes(s.projectId, list);
    useEditStudio.getState().setMattes(states ?? []);
    syncMatteRanges(states ?? []);
  } catch {
    // stays unknown
  }
}

/**
 * Mount once in the editor (and in each part window). In a part window
 * (replica mode) it only loads the analysis from the replicated ref: sources,
 * mattes and URLs come from the host, and it never submits a job or saves.
 */
export function useEditData(): void {
  const replica = isReplicaWindow();
  const projectId = useEditStudio((s) => s.projectId);
  const key = useEditStudio((s) => s.history?.present.analysisKey ?? "");
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const refKey = useEditStudio((s) => s.analysisRef?.key ?? "");
  useEffect(() => {
    if (!replica) void useAnalysisKey(key);
  }, [replica, projectId, key]);
  useEffect(() => {
    if (replica || !projectId) return;
    void refreshSources();
    void refreshMattes();
  }, [replica, projectId, fps]);
  useEffect(() => {
    if (!replica) return;
    const st = useEditStudio.getState();
    const ref = st.analysisRef;
    if (!ref) {
      if (st.analysis) useEditStudio.setState({ analysis: null });
      return;
    }
    if (st.analysis) return;
    let live = true;
    loadRef(ref).then(
      (a) => {
        if (live && useEditStudio.getState().analysisRef?.key === ref.key) useEditStudio.setState({ analysis: a });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [replica, refKey]);
}

/**
 * Matte files cover a padded source range (Go pads ±500 ms, §10.5). The engine
 * maps matte frames through clip.matte.fromMs, so the document must carry the
 * range the files really cover. Updates the present document in place (not an
 * undo step); autosave stores it.
 */
export function syncMatteRanges(states: readonly EditMatteState[]): void {
  if (isReplicaWindow()) return;
  const st = useEditStudio.getState();
  const h = st.history;
  if (!h) return;
  const byId = new Map(states.filter((m) => m.ready && m.toMs > m.fromMs).map((m) => [m.id, m]));
  if (!byId.size) return;
  let changed = false;
  const tracks = h.present.tracks.map((t) => {
    let tc = false;
    const clips = t.clips.map((c) => {
      const m = c.matte?.id ? byId.get(c.matte.id) : undefined;
      if (!m || !c.matte || (c.matte.fromMs === m.fromMs && c.matte.toMs === m.toMs)) return c;
      tc = true;
      return { ...c, matte: { ...c.matte, fromMs: m.fromMs, toMs: m.toMs } };
    });
    if (!tc) return t;
    changed = true;
    return { ...t, clips };
  });
  if (!changed) return;
  useEditStudio.setState({ history: { ...h, present: { ...h.present, tracks } }, saveState: "dirty" });
}
