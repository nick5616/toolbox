/**
 * Edit Studio (Phase 9 SPEC §14). Wave 0 shell: routing between the projects
 * home, Setup and the editor; the header; panel slots filled by the work
 * packages. Packages own the components it imports, not this file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorBoundary, IconButton, MenuButton, toast } from "@/components";
import { EditStudioService, SettingsService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { DepsGate } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { EditCanvas, type EditCanvasStats } from "@/viz/edit/EditCanvas";
import { normalizeProject } from "@/viz/edit/defaults";
import { previewSize } from "@/viz/edit/types";
import { AutofillDialog } from "./autofill/AutofillDialog";
import { CaptionsPanel } from "./captions/CaptionsPanel";
import { exportSrt } from "./captions/exportSrt";
import { ExportDialog } from "./export/ExportDialog";
import { useEditHandoff } from "./home/handoff";
import { ProjectsHome } from "./home/ProjectsHome";
import { InspectorPanel } from "./inspector/InspectorPanel";
import { exportMarkers } from "./lanes/exportMarkers";
import { LanesPanel } from "./lanes/LanesPanel";
import { SectionBands } from "./lanes/SectionBands";
import { PreviewOverlays } from "./overlays/PreviewOverlays";
import { SetupPanel } from "./setup/SetupPanel";
import { SourcesPanel } from "./sources/SourcesPanel";
import { TracksPanel } from "./timeline/TracksPanel";
import { useEditCommands } from "./transport/commands";
import { Transport } from "./transport/Transport";
import { useEditInputs, useEditStudio, useProject } from "./store";
import { flushEdit, markOpened, onEditSaved, useEditAutosave } from "./useEditAutosave";
import { useEditData } from "./useEditData";
import styles from "./EditStudioView.module.css";
import { HeaderControls } from "./beatsync/HeaderControls";
import { HEADER_PX, xToMs } from "./geometry";
import { editLength } from "@/viz/edit/types";
import { seekTo } from "./transport/player";

const SAVE_LABEL: Record<string, string> = { idle: "", dirty: "Unsaved", saving: "Saving…", saved: "Saved", error: "Couldn't save" };
const SAVE_TIPS: Record<string, string | undefined> = {
  idle: undefined,
  dirty: "Changes are waiting to be saved; this happens automatically",
  saving: "Saving your changes",
  saved: "All changes are saved",
  error: "The last save failed",
};

export default function EditStudioView({ moduleId }: ToolViewProps) {
  const projectId = useEditStudio((s) => s.projectId);

  const open = useCallback(
    async (id: string) => {
      await flushEdit();
      try {
        const [doc, list] = await Promise.all([EditStudioService.Get(id), EditStudioService.List()]);
        const name = (list ?? []).find((p) => p.id === id)?.name ?? "Untitled";
        const n = normalizeProject(doc);
        useEditStudio.getState().open(id, name, n);
        markOpened(id, name, n);
        void SettingsService.SetModuleState(moduleId, JSON.stringify({ lastProjectId: id })).catch(() => undefined);
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
      }
    },
    [moduleId],
  );

  // Reopen the last edit.
  useEffect(() => {
    if (useEditStudio.getState().projectId) return;
    void SettingsService.ModuleState(moduleId)
      .then((raw) => {
        const last = raw ? (JSON.parse(raw) as { lastProjectId?: unknown }).lastProjectId : undefined;
        if (useUI.getState().handoff?.moduleId === moduleId) return; // a handoff decides what opens
        if (typeof last === "string" && last && !useEditStudio.getState().projectId) void open(last);
      })
      .catch(() => undefined);
  }, [moduleId, open]);

  useEditHandoff(moduleId, (id) => void open(id));

  return (
    <div className={styles.root}>
      <DepsGate moduleId={moduleId} />
      {projectId ? <Editor moduleId={moduleId} /> : <ProjectsHome moduleId={moduleId} onOpen={(id) => void open(id)} />}
    </div>
  );
}

function Editor({ moduleId }: { moduleId: string }) {
  useEditAutosave();
  useEditData();
  useEditCommands();
  const project = useProject();
  const name = useEditStudio((s) => s.name);
  const saveState = useEditStudio((s) => s.saveState);
  const saveError = useEditStudio((s) => s.saveError);
  const canUndo = useEditStudio((s) => (s.history?.past.length ?? 0) > 0);
  const canRedo = useEditStudio((s) => (s.history?.future.length ?? 0) > 0);
  const analysisState = useEditStudio((s) => s.analysisState);
  const setupOpen = useEditStudio((s) => s.setupOpen);
  const rightPanel = useEditStudio((s) => s.rightPanel);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const playing = useEditStudio((s) => s.playing);
  const selection = useEditStudio((s) => s.selection);
  const inputs = useEditInputs();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<EditCanvasStats | null>(null);
  const dialog = useEditStudio((s) => s.dialog);
  const [split, setSplit] = useState(loadSplit);
  const splitDrag = useRef<{ top: number; height: number } | null>(null);
  const projectId = useEditStudio((s) => s.projectId);
  void moduleId;

  // Thumbnail: after a save, at most every 30 s, the preview at the playhead.
  const lastThumb = useRef(0);
  useEffect(
    () =>
      onEditSaved((info) => {
        const now = Date.now();
        if (!canvas || now - lastThumb.current < 30_000) return;
        lastThumb.current = now;
        const url = thumbnail(canvas);
        if (url) void EditStudioService.SaveThumb(info.id, url).catch(() => undefined);
      }),
    [canvas],
  );
  useEffect(() => {
    lastThumb.current = 0;
  }, [projectId]);

  if (!project) return null;
  const setup = !project.song || analysisState !== "ready" || setupOpen;
  const size = previewSize(project.aspect);
  const close = async () => {
    await flushEdit();
    useEditStudio.getState().close();
  };

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <IconButton icon="arrow-left" label="All edits" data-tip="Save and go back to the list of your edits" onClick={() => void close()} />
        <input
          className={styles.name}
          value={name}
          aria-label="Edit name"
          data-tip="The name of this edit; changes save automatically"
          onChange={(e) => useEditStudio.getState().setName(e.target.value)}
        />
        <span className={styles.save} data-tip={saveError ?? SAVE_TIPS[saveState]}>
          {SAVE_LABEL[saveState]}
        </span>
        <HeaderControls disabled={setup} />
        <div className={styles.spacer} />
        <IconButton icon="undo-2" label="Undo" data-tip={canUndo ? "Undo the last change" : "Nothing to undo yet"} kbd="Mod+Z" disabled={!canUndo} onClick={() => useEditStudio.getState().undo()} />
        <IconButton icon="redo-2" label="Redo" data-tip={canRedo ? "Redo the change you undid" : "Nothing to redo"} kbd="Mod+Shift+Z" disabled={!canRedo} onClick={() => useEditStudio.getState().redo()} />
        <Button icon="wand-sparkles" collapsible data-tip={setup ? "Set up the song first" : "Fill the timeline with clips cut to the music using a recipe (the selected range, if any)"} disabled={setup} onClick={() => useEditStudio.getState().openDialog({ kind: "autofill", range: selection?.kind === "range" ? { fromMs: selection.fromMs, toMs: selection.toMs } : null })}>
          Auto-fill
        </Button>
        <MenuButton
          label="More"
          icon="ellipsis"
          variant="ghost"
          items={() => [
            { id: "markers-csv", label: "Export markers (CSV)", tip: "Save the beat, kick, snare and other marker times as a spreadsheet file", disabled: setup, onSelect: () => void exportMarkers("csv") },
            { id: "markers-json", label: "Export markers (JSON)", tip: "Save the marker times as a JSON file for other software", disabled: setup, onSelect: () => void exportMarkers("json") },
            { id: "srt", label: "Export captions (SRT)", tip: project.captions ? "Save the captions as an SRT subtitle file" : "Turn captions on first", disabled: setup || !project.captions, onSelect: () => void exportSrt() },
          ]}
        />
        <Button variant="primary" icon="download" collapsible data-tip={setup ? "Set up the song first" : "Render the edit to a video file"} disabled={setup} onClick={() => useEditStudio.getState().openDialog({ kind: "export" })}>
          Export
        </Button>
      </header>

      <div className={styles.top} style={{ flex: `0 0 ${Math.round(split * 100)}%` }}>
        <aside className={styles.sources}>
          <ErrorBoundary label="Sources" compact>
            <SourcesPanel />
          </ErrorBoundary>
        </aside>
        <section className={styles.preview}>
          <EditCanvas
            inputs={setup ? null : inputs}
            width={size.width}
            height={size.height}
            timeMs={playheadMs}
            playing={playing}
            quality="draft"
            onStats={setStats}
            onCanvas={setCanvas}
          />
          <ErrorBoundary label="The preview overlays" compact>
            <PreviewOverlays canvas={canvas} width={size.width} height={size.height} />
          </ErrorBoundary>
          {stats && playing && inputs && !setup && <span className={styles.stats} data-tip="Preview speed while playing: frames per second and frames that were dropped to keep up">{`${Math.round(stats.fps)} fps · ${stats.dropped} dropped`}</span>}
        </section>
        <aside className={styles.right}>
          <div className={styles.tabs} role="tablist">
            <button role="tab" aria-selected={rightPanel === "inspector"} data-tip="Settings of the selected clip, track, song or marker" className={styles.tab} onClick={() => useEditStudio.getState().setRightPanel("inspector")}>
              Inspector
            </button>
            <button role="tab" aria-selected={rightPanel === "captions"} data-tip="Words from the song shown on the picture as captions" className={styles.tab} onClick={() => useEditStudio.getState().setRightPanel("captions")}>
              Captions
            </button>
          </div>
          <div className={styles.panel}>
            <ErrorBoundary label={rightPanel === "inspector" ? "The Inspector" : "Captions"} resetKey={rightPanel} compact>
              {rightPanel === "inspector" ? <InspectorPanel /> : <CaptionsPanel />}
            </ErrorBoundary>
          </div>
        </aside>
      </div>

      <div
        className={styles.splitter}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the preview"
        data-tip="Drag up or down to give the preview or the timeline more room"
        onPointerDown={(e) => {
          const box = e.currentTarget.parentElement?.getBoundingClientRect();
          if (!box) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          splitDrag.current = { top: box.top + HEADER_H, height: box.height - HEADER_H };
        }}
        onPointerMove={(e) => {
          const d = splitDrag.current;
          if (d) setSplit(clampSplit((e.clientY - d.top) / d.height));
        }}
        onPointerUp={(e) => {
          splitDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          saveSplit(split);
        }}
      />
      {setup ? (
        <div className={styles.setup}>
          <ErrorBoundary label="Setup" compact>
            <SetupPanel />
          </ErrorBoundary>
        </div>
      ) : (
        <div className={styles.bottom}>
          <Transport />
          <div
            className={styles.timeline}
            onDoubleClick={(e) => {
              // Double-click anywhere along the time (lanes or tracks) puts the playhead there.
              const r = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - r.left - HEADER_PX;
              if (x < 0 || (e.target as HTMLElement).closest("input,button,[data-trim],[role=menu]")) return;
              const st = useEditStudio.getState();
              seekTo(Math.max(0, Math.min(editLength(project), xToMs(x, st.pps, st.scrollMs))));
            }}
          >
            <SectionBands className={styles.bands} />
            <ErrorBoundary label="The lanes" compact>
              <LanesPanel />
            </ErrorBoundary>
            <ErrorBoundary label="The timeline" compact>
              <TracksPanel />
            </ErrorBoundary>
          </div>
        </div>
      )}

      <AutofillDialog open={dialog?.kind === "autofill"} range={dialog?.kind === "autofill" ? dialog.range : null} onClose={() => useEditStudio.getState().openDialog(null)} />
      <ExportDialog open={dialog?.kind === "export"} onClose={() => useEditStudio.getState().openDialog(null)} />
    </div>
  );
}

/** A 320 px JPEG data URL of the preview canvas, or null. */
function thumbnail(src: HTMLCanvasElement): string | null {
  try {
    const scale = 320 / Math.max(src.width, src.height);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

const HEADER_H = 46; // the editor header above the panels
const SPLIT_KEY = "edit-studio.split";
const clampSplit = (f: number) => Math.max(0.28, Math.min(0.72, f));

/** The preview's share of the editor height (remembered per machine; smaller screens start lower). */
function loadSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    if (v > 0) return clampSplit(v);
  } catch {
    // storage unavailable: use the default
  }
  return typeof window !== "undefined" && window.innerHeight < 850 ? 0.42 : 0.52;
}

function saveSplit(f: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(f));
  } catch {
    // not remembered
  }
}
