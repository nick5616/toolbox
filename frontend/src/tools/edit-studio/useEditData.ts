/**
 * Loads what the open edit needs besides its document (Phase 9 SPEC §14.12;
 * Wave 0): the song's analysis (from analysisKey), source states and matte
 * states. Packages refresh sources/mattes themselves after their jobs, with
 * refreshSources / refreshMattes.
 */
import { useEffect } from "react";
import { EditStudioService, MediaService, type AnalysisRef } from "@/lib/api";
import { loadAnalysis, type Analysis } from "@/viz/analysis";
import { useEditStudio } from "./store";

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
  const s = useEditStudio.getState();
  const p = s.history?.present;
  if (!p || !s.projectId) return;
  const list = ids ?? p.tracks.flatMap((t) => t.clips.map((c) => c.matte?.id ?? "").filter(Boolean));
  if (!list.length) return;
  try {
    const states = await EditStudioService.Mattes(s.projectId, list);
    useEditStudio.getState().setMattes(states ?? []);
  } catch {
    // stays unknown
  }
}

/** Mount once in the editor. */
export function useEditData(): void {
  const projectId = useEditStudio((s) => s.projectId);
  const key = useEditStudio((s) => s.history?.present.analysisKey ?? "");
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  useEffect(() => {
    void useAnalysisKey(key);
  }, [projectId, key]);
  useEffect(() => {
    if (!projectId) return;
    void refreshSources();
    void refreshMattes();
  }, [projectId, fps]);
}
