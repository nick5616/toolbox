/**
 * Source actions (Phase 9 SPEC §14.6): add files (Probe, append to Sources,
 * Prepare), re-prepare, relink a missing file. Used by the panel, handoffs and
 * the New edit dialog.
 */
import { pickFromLibrary } from "@/blocks/library-picker";
import { toast } from "@/components";
import { EditStudioService, FilesService } from "@/lib/api";
import type { Job } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isActive, useJobs } from "@/state/jobs";
import { commit, currentDoc } from "../timeline/actions";
import { useEditStudio } from "@/editor/store";
import { refreshSources } from "@/editor/useEditData";
import { appendSources, MAX_SOURCES, relinkPath } from "./tags";

export const MEDIA_EXTENSIONS = [".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp", ".ogv", ".mpg", ".mpeg", ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"];

/** Prepare jobs this panel follows; each refreshes the source states when it ends. */
const following = new Set<string>();

/** Starts following a prepare job: the store remembers it and the states refresh when it ends. */
export function trackPrepare(job: Job): void {
  useJobs.getState().upsert(job);
  following.add(job.id);
  useEditStudio.getState().setJob("prepare", job.id);
}

/** Subscribes to the jobs store; call once while the Sources panel is mounted. Returns an unsubscribe. */
export function watchPrepareJobs(): () => void {
  return useJobs.subscribe((s) => {
    for (const id of [...following]) {
      const j = s.byId[id];
      if (!j || isActive(j)) continue;
      following.delete(id);
      const st = useEditStudio.getState();
      if (st.jobs.prepare === id) st.setJob("prepare", undefined);
      void refreshSources();
    }
  });
}

/** Submits one prepare job for the paths at the project's fps. */
export async function prepare(paths: string[]): Promise<void> {
  const st = useEditStudio.getState();
  const doc = st.history?.present;
  if (!st.projectId || !doc || !paths.length) return;
  try {
    const job = await EditStudioService.Prepare(st.projectId, paths, doc.fps);
    trackPrepare(job);
    void refreshSources(paths);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/**
 * Probes files, adds the photos and videos to the open edit's Sources
 * (deduplicated, ≤ 300) and prepares the new ones. Returns the paths added.
 */
export async function addSourcePaths(paths: readonly string[]): Promise<string[]> {
  const doc = currentDoc();
  if (!doc || !paths.length) return [];
  const fresh = [...new Set(paths)].filter((p) => !doc.sources.some((s) => s.path === p));
  if (!fresh.length) return [];
  let usable: string[] = [];
  try {
    const infos = (await EditStudioService.Probe(fresh)) ?? [];
    usable = infos.filter((i) => (i.kind === "video" || i.kind === "image") && !i.error).map((i) => i.path);
    const skipped = fresh.length - usable.length;
    if (skipped > 0) toast({ title: `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} that aren't readable photos or videos`, tone: "warn" });
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
    return [];
  }
  const cur = currentDoc();
  if (!cur) return [];
  const { project, added } = appendSources(cur, usable);
  if (project.sources.length >= MAX_SOURCES && added.length < usable.length) {
    toast({ title: "Sources hold at most 300 files", tone: "warn" });
  }
  if (!added.length) return [];
  commit(project);
  await prepare(added);
  return added;
}

/** Picks files with the native dialog and adds them. */
export async function pickAndAddSources(): Promise<void> {
  try {
    const picked = (await FilesService.PickWith("Add clips and photos", MEDIA_EXTENSIONS, true)) ?? [];
    if (picked.length) await addSourcePaths(picked);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/** Picks files from the Library and adds them (same path as the native pick). */
export async function pickLibraryAndAddSources(): Promise<void> {
  try {
    const have = currentDoc()?.sources.map((s) => s.path);
    const picked = await pickFromLibrary({ title: "Add clips and photos from Library", exts: MEDIA_EXTENSIONS, multiple: true, have });
    if (picked.length) await addSourcePaths(picked);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/** Picks a folder and adds the videos and photos directly inside it (not subfolders, no dot files). */
export async function pickFolderAndAddSources(): Promise<void> {
  try {
    const dir = await FilesService.PickFolder("Add a folder of clips and photos");
    if (!dir) return;
    const paths = (await EditStudioService.ListFolder(dir)) ?? [];
    if (!paths.length) {
      toast({ title: "No clips or photos in that folder", tone: "warn" });
      return;
    }
    await addSourcePaths(paths);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/** Picks a new file for a source whose file is gone and points every clip and source entry at it. */
export async function relinkSource(path: string): Promise<void> {
  try {
    const picked = (await FilesService.PickWith("Find the file", MEDIA_EXTENSIONS, false)) ?? [];
    const to = picked[0];
    if (!to) return;
    const doc = currentDoc();
    if (!doc) return;
    commit(relinkPath(doc, path, to));
    const info = (await EditStudioService.Probe([to]))?.[0];
    if (info && (info.kind === "video" || info.kind === "image") && !info.error) await prepare([to]);
    else toast({ title: "That file can't be read as a photo or video", tone: "warn" });
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}
