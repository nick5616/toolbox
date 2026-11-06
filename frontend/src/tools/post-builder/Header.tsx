/**
 * The header line (Phase 11, SPEC §5.2): Posts chip (the open post's name) and
 * the quiet save state | undo · redo · ⋯ · Export. While an export runs the right
 * side shows its progress. Never wraps. Export runs only in the host window.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, MenuButton, Meter, Tooltip, toast } from "@/components";
import { JobStatus, LibraryService, PostsService } from "@/lib/api";
import { isActive, useJob, useJobs } from "@/state/jobs";
import { Spacer, WorkspacePanel } from "@/workspace";
import { firstError } from "./logic";
import { useLastPostExport } from "./lastExport";
import { usePostDialogs } from "./postDialogs";
import { fail, useDoc, usePostBuilder, type SaveState } from "./postStore";
import { copyText } from "./SidePanel";
import { postWorkspace as ws } from "./workspace";
import styles from "./Header.module.css";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", error: "Couldn't save" };

interface ExportOutcome {
  folder: string;
  files: string[];
}

function parseExport(json: string): ExportOutcome | null {
  try {
    const r = JSON.parse(json) as { folder?: unknown; files?: unknown };
    const files = Array.isArray(r.files) ? r.files.filter((x): x is string => typeof x === "string") : [];
    return typeof r.folder === "string" ? { folder: r.folder, files } : null;
  } catch {
    return null;
  }
}

export function PostHeader() {
  const st = usePostBuilder.getState;
  const doc = useDoc();
  const postId = usePostBuilder((s) => s.postId);
  const name = usePostBuilder((s) => s.name);
  const saveState = usePostBuilder((s) => s.saveState);
  const issues = usePostBuilder((s) => s.issues);
  const exportFolder = usePostBuilder((s) => s.pstate.exports[s.postId] ?? "");
  const undoable = usePostBuilder((s) => (s.history?.past.length ?? 0) > 0);
  const redoable = usePostBuilder((s) => (s.history?.future.length ?? 0) > 0);
  const dialogs = usePostDialogs();

  const [jobId, setJobId] = useState("");
  const [exporting, setExporting] = useState(false);
  const job = useJob(jobId);
  const running = !!job && isActive(job);
  const announced = useRef("");
  const exportPost = useRef("");

  const openFolder = useCallback((folder: string) => {
    const p = folder ? LibraryService.RevealPath(folder) : LibraryService.OpenLibraryFolder("Posts");
    p.catch(fail);
  }, []);

  useEffect(() => {
    if (!job || job.id !== jobId || announced.current === job.id) return;
    if (job.status === JobStatus.JobDone) {
      announced.current = job.id;
      const outcome = parseExport(job.resultJson);
      const folder = outcome?.folder ?? "";
      if (folder) {
        const cur = st().pstate;
        const pid = exportPost.current || st().postId;
        st().persist({ ...cur, exports: { ...cur.exports, [pid]: folder } });
        // The result row under the stage carries Send to and the drag; no toast.
        useLastPostExport.getState().set({ postId: pid, folder, files: outcome?.files ?? [] });
      } else {
        toast({ tone: "success", title: "Post exported" });
      }
    } else if (job.status === JobStatus.JobFailed) {
      announced.current = job.id;
      toast({ tone: "danger", title: job.error || "The export failed", description: job.errorHint || undefined });
    }
  }, [job, jobId, openFolder, st]);

  const blocking = firstError(issues);
  const canExport = !!doc && !!postId && !blocking && !exporting && !running && doc.slides.length > 0;
  const doExport = async () => {
    if (!canExport) return;
    setExporting(true);
    try {
      await st().flush();
      exportPost.current = postId;
      const j = await PostsService.Export(postId);
      useJobs.getState().upsert(j);
      setJobId(j.id);
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  const lastExport = exportFolder ? exportFolder.split(/[\\/]+/).filter(Boolean).pop() || exportFolder : "";

  return (
    <div className={styles.bar} role="toolbar" aria-label="Post tools">
      <WorkspacePanel ws={ws} panel="posts" summary={name} className={styles.posts} />
      <span className={styles.save} role="status" data-state={saveState} data-tip="Changes are saved automatically as you edit">
        {SAVE_LABEL[saveState]}
      </span>
      <Spacer />
      {running && job ? (
        <div className={styles.progress}>
          <Meter value={job.progress} status="running" label="Export progress" />
          <span className={styles.progressMsg}>{job.message || "Exporting…"}</span>
          <Button size="sm" variant="ghost" data-tip="Stop exporting this post" onClick={() => void useJobs.getState().cancel(job.id)}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <IconButton icon="undo-2" label="Undo" data-tip="Undo the last change" kbd="Ctrl+Z" disabled={!undoable} onClick={() => st().undo()} />
          <IconButton icon="redo-2" label="Redo" data-tip="Redo the change you just undid" kbd="Ctrl+Shift+Z" disabled={!redoable} onClick={() => st().redo()} />
          <MenuButton
            size="sm"
            variant="ghost"
            icon="ellipsis"
            label="More export actions"
            tip={lastExport ? `Last export: ${lastExport}` : "Rename the post, copy the caption or open your exports"}
            items={() => [
              { id: "rename", label: "Rename post…", icon: "pencil", tip: "Change the name of this post", onSelect: () => dialogs.openRename(postId) },
              { id: "copy-caption", label: "Copy caption", icon: "copy", tip: "Copy the caption to paste into Instagram", disabled: !doc, onSelect: () => void copyText(doc?.caption ?? "", "Caption copied") },
              {
                id: "open-folder",
                label: lastExport ? `Open last export (${lastExport})` : "Open Posts folder",
                icon: "folder-open",
                tip: exportFolder || "Show the exported posts in your file manager",
                onSelect: () => openFolder(exportFolder),
              },
            ]}
          />
          <Tooltip label={blocking ? `${blocking.message} (fix it in Checks to export)` : "Write the post to a folder"}>
            <span data-testid="export-blocker" data-blocked={blocking ? "true" : undefined}>
              <Button variant="primary" icon="download" disabled={!canExport} loading={exporting} onClick={() => void doExport()}>
                Export
              </Button>
            </span>
          </Tooltip>
        </>
      )}
      {dialogs.node}
    </div>
  );
}
