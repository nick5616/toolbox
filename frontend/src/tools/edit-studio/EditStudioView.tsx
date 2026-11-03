/**
 * Edit Studio (Phase 9 SPEC §14). Wave 0 shell: routing between the projects
 * home, Setup and the editor; the header; panel slots filled by the work
 * packages. Packages own the components it imports, not this file.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, IconButton, MenuButton, toast } from "@/components";
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
import { flushEdit, markOpened, useEditAutosave } from "./useEditAutosave";
import { useEditData } from "./useEditData";
import styles from "./EditStudioView.module.css";

const SAVE_LABEL: Record<string, string> = { idle: "", dirty: "Unsaved", saving: "Saving…", saved: "Saved", error: "Couldn't save" };

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
  const rightPanel = useEditStudio((s) => s.rightPanel);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const playing = useEditStudio((s) => s.playing);
  const selection = useEditStudio((s) => s.selection);
  const inputs = useEditInputs();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<EditCanvasStats | null>(null);
  const [autofill, setAutofill] = useState(false);
  const [exporting, setExporting] = useState(false);
  void moduleId;

  if (!project) return null;
  const setup = !project.song || analysisState !== "ready";
  const size = previewSize(project.aspect);
  const close = async () => {
    await flushEdit();
    useEditStudio.getState().close();
  };

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <IconButton icon="arrow-left" label="All edits" onClick={() => void close()} />
        <input
          className={styles.name}
          value={name}
          aria-label="Edit name"
          onChange={(e) => useEditStudio.getState().setName(e.target.value)}
        />
        <span className={styles.save} title={saveError ?? undefined}>
          {SAVE_LABEL[saveState]}
        </span>
        <Badge>{project.aspect}</Badge>
        <Badge>{project.fps} fps</Badge>
        <div className={styles.spacer} />
        <IconButton icon="undo-2" label="Undo" kbd="Mod+Z" disabled={!canUndo} onClick={() => useEditStudio.getState().undo()} />
        <IconButton icon="redo-2" label="Redo" kbd="Mod+Shift+Z" disabled={!canRedo} onClick={() => useEditStudio.getState().redo()} />
        <Button icon="wand-sparkles" disabled={setup} onClick={() => setAutofill(true)}>
          Auto-fill
        </Button>
        <MenuButton
          label="More"
          icon="ellipsis"
          variant="ghost"
          items={() => [
            { id: "markers-csv", label: "Export markers (CSV)", disabled: setup, onSelect: () => void exportMarkers("csv") },
            { id: "markers-json", label: "Export markers (JSON)", disabled: setup, onSelect: () => void exportMarkers("json") },
            { id: "srt", label: "Export captions (SRT)", disabled: setup || !project.captions, onSelect: () => void exportSrt() },
          ]}
        />
        <Button variant="primary" icon="download" disabled={setup} onClick={() => setExporting(true)}>
          Export
        </Button>
      </header>

      <div className={styles.top}>
        <aside className={styles.sources}>
          <SourcesPanel />
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
          <PreviewOverlays canvas={canvas} width={size.width} height={size.height} />
          {stats && <span className={styles.stats}>{`${Math.round(stats.fps)} fps · ${stats.dropped} dropped`}</span>}
        </section>
        <aside className={styles.right}>
          <div className={styles.tabs} role="tablist">
            <button role="tab" aria-selected={rightPanel === "inspector"} className={styles.tab} onClick={() => useEditStudio.getState().setRightPanel("inspector")}>
              Inspector
            </button>
            <button role="tab" aria-selected={rightPanel === "captions"} className={styles.tab} onClick={() => useEditStudio.getState().setRightPanel("captions")}>
              Captions
            </button>
          </div>
          <div className={styles.panel}>{rightPanel === "inspector" ? <InspectorPanel /> : <CaptionsPanel />}</div>
        </aside>
      </div>

      {setup ? (
        <div className={styles.setup}>
          <SetupPanel />
        </div>
      ) : (
        <div className={styles.bottom}>
          <Transport />
          <div className={styles.timeline}>
            <SectionBands className={styles.bands} />
            <LanesPanel />
            <TracksPanel />
          </div>
        </div>
      )}

      <AutofillDialog open={autofill} range={selection?.kind === "range" ? { fromMs: selection.fromMs, toMs: selection.toMs } : null} onClose={() => setAutofill(false)} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
    </div>
  );
}
