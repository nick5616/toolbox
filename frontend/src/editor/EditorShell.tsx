/**
 * The editor's shell (Phase 10 SPEC §5.3): routing between the projects home
 * and the editor, the header, the panels and the timeline, composed by an
 * `EditorProfile`. The Video Editor is this shell with the plain profile;
 * Edit Studio is the same shell with the music layer plugged in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ClickInHost, ErrorBoundary, IconButton, MenuButton, SegmentedControl, ToolHeader, toast, type MenuItem } from "@/components";
import { EditStudioService, SettingsService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isEditableTarget } from "@/lib/shortcuts";
import { useBeforePopOut } from "@/lib/popout";
import { WorkspacePreviewFrame } from "@/workspace";
import { useUI } from "@/state/ui";
import { DepsGate } from "@/tools/_kit";
import { EditCanvas, type EditCanvasStats } from "@/viz/edit/EditCanvas";
import { normalizeProject } from "@/viz/edit/defaults";
import { editLength, previewSize } from "@/viz/edit/types";
import { useEditorComposition } from "./constituents/useEditorComposition";
import { ExportDialog } from "./export/ExportDialog";
import { enterVideoFocus, hasFocusSwitch, leaveVideoFocus, useEffectiveFocus } from "./focus";
import { HEADER_PX, xToMs } from "./geometry";
import { useEditHandoff } from "./home/handoff";
import { SongReplaceDialog } from "./home/SongReplaceDialog";
import { ProjectsHome } from "./home/ProjectsHome";
import { PreviewOverlays } from "./overlays/PreviewOverlays";
import { Rail } from "./Rail";
import type { EditorProfile } from "./profile";
import { EditorProfileProvider, profileTitle } from "./profileContext";
import { useEditInputs, useEditStudio, useProject } from "./store";
import { TracksPanel } from "./timeline/TracksPanel";
import { Ruler } from "./timeline/Ruler";
import { useEditCommands } from "./transport/commands";
import { seekTo } from "./transport/player";
import { Transport } from "./transport/Transport";
import { flushEdit, markOpened, onEditSaved, useEditAutosave } from "./useEditAutosave";
import { useEditData } from "./useEditData";
import { defineEditorWorkspace } from "./workspace";
import styles from "./EditorShell.module.css";

const SAVE_LABEL: Record<string, string> = { idle: "", dirty: "Unsaved", saving: "Saving…", saved: "Saved", error: "Couldn't save" };
const SAVE_TIPS: Record<string, string | undefined> = {
  idle: undefined,
  dirty: "Changes are waiting to be saved; this happens automatically",
  saving: "Saving your changes",
  saved: "All changes are saved",
  error: "The last save failed",
};

/** The other tool a project can be opened in, by module id. */
const OTHER_TOOL: Record<string, { id: string; label: string; tip: string } | undefined> = {
  "edit-studio": { id: "video-studio", label: "Open in Video Editor", tip: "Edit this project as a plain video, without the song layer" },
  "video-studio": { id: "edit-studio", label: "Open in Edit Studio", tip: "Add the song layer: markers, beat sync and recipes" },
};

/** Opens the open project in the other tool: the editor store is shared, so it stays open. */
export async function openInOtherTool(moduleId: string): Promise<void> {
  const other = OTHER_TOOL[moduleId];
  const id = useEditStudio.getState().projectId;
  if (!other || !id) return;
  await flushEdit();
  await SettingsService.SetModuleState(other.id, JSON.stringify({ lastProjectId: id })).catch(() => undefined);
  useUI.getState().navigate(other.id);
}

export interface EditorShellProps {
  moduleId: string;
  profile: EditorProfile;
}

export function EditorShell({ moduleId, profile }: EditorShellProps) {
  const projectId = useEditStudio((s) => s.projectId);
  // Popping the tool out saves first, so the new window reopens the latest version.
  useBeforePopOut(moduleId, flushEdit);

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

  // Reopen the last project.
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
    <EditorProfileProvider profile={profile}>
      <div className={styles.root}>
        <DepsGate moduleId={moduleId} />
        {projectId ? <Editor moduleId={moduleId} profile={profile} /> : <ProjectsHome moduleId={moduleId} profile={profile} onOpen={(id) => void open(id)} />}
      </div>
    </EditorProfileProvider>
  );
}

function Editor({ moduleId, profile }: { moduleId: string; profile: EditorProfile }) {
  const ws = defineEditorWorkspace(profile);
  useEditAutosave();
  useEditData();
  ws.useHost(); // hosts the store bridge for pop-out parts
  useEditCommands();
  useEditorComposition(profile);
  const project = useProject();
  const name = useEditStudio((s) => s.name);
  const saveState = useEditStudio((s) => s.saveState);
  const saveError = useEditStudio((s) => s.saveError);
  const canUndo = useEditStudio((s) => (s.history?.past.length ?? 0) > 0);
  const canRedo = useEditStudio((s) => (s.history?.future.length ?? 0) > 0);
  const analysisState = useEditStudio((s) => s.analysisState);
  const setupOpen = useEditStudio((s) => s.setupOpen);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const playing = useEditStudio((s) => s.playing);
  const inputs = useEditInputs();
  const focus = useEffectiveFocus();
  const switchable = hasFocusSwitch(profile);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<EditCanvasStats | null>(null);
  const dialog = useEditStudio((s) => s.dialog);
  const [split, setSplit] = useState(loadSplit);
  const splitDrag = useRef<{ top: number; height: number } | null>(null);
  const projectId = useEditStudio((s) => s.projectId);
  const other = OTHER_TOOL[moduleId];

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
    leaveVideoFocus(); // every project opens on the composition
  }, [projectId]);

  // Esc leaves Video focus, unless something else (a dialog, a menu, a text field) is using it.
  useEffect(() => {
    if (!switchable || focus !== "video") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target) || useEditStudio.getState().dialog) return;
      if (document.querySelector('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]')) return;
      leaveVideoFocus();
    };
    // Capture: runs before a menu or popover closes itself on the same key.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [switchable, focus]);

  if (!project) return null;
  const setup = profile.song === "analyzed" && (!project.song || analysisState !== "ready" || setupOpen);
  const size = previewSize(project.aspect);
  const close = async () => {
    await flushEdit();
    useEditStudio.getState().close();
  };
  const title = profileTitle(profile);
  const videoFocus = switchable && focus === "video";
  const HeaderStart = profile.HeaderStart;
  const HeaderEnd = profile.HeaderEnd;
  const Setup = profile.Setup;
  const TimelineTop = profile.TimelineTop;
  const Dialogs = profile.Dialogs;
  const moreItems = (): MenuItem[] => [
    ...(profile.moreItems?.({ disabled: setup, project }) ?? []),
    ...(other ? [{ id: "open-other", label: other.label, tip: other.tip, onSelect: () => void openInOtherTool(moduleId) }] : []),
  ];

  return (
    <div className={styles.editor} data-focus={focus} data-profile={moduleId}>
      <ClickInHost className={styles.host}>
      <ToolHeader className={styles.header} aria-label={`${title} header`}>
        {videoFocus ? (
          <>
            <Button size="sm" variant="ghost" icon="chevron-left" aria-label={`Back to ${title}`} data-tip={`Back to the song view of ${title} (Esc)`} onClick={leaveVideoFocus}>
              Song view
            </Button>
            <span className={styles.crumb} data-testid="breadcrumb" aria-label={`${title}, Clip view`}>
              <span className={styles.crumbParent}>{title}</span>
              <span className={styles.crumbSep} aria-hidden="true">
                ›
              </span>
              <span>Clip view</span>
            </span>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon="chevron-left" aria-label={`All ${profile.noun}s`} data-tip={`Save and go back to the list of your ${profile.noun}s`} onClick={() => void close()}>
            {`${profile.noun.charAt(0).toUpperCase()}${profile.noun.slice(1)}s`}
          </Button>
        )}
        <input
          className={styles.name}
          value={name}
          aria-label="Edit name"
          data-tip={`The name of this ${profile.noun}; changes save automatically`}
          onChange={(e) => useEditStudio.getState().setName(e.target.value)}
        />
        <span className={styles.save} data-tip={saveError ?? SAVE_TIPS[saveState]}>
          {SAVE_LABEL[saveState]}
        </span>
        {switchable && (
          <SegmentedControl
            size="sm"
            aria-label="Focus"
            value={focus}
            onChange={(v) => (v === "video" ? enterVideoFocus() : leaveVideoFocus())}
            options={[
              { value: "compose", label: "Song view", tip: "Song, markers and recipes" },
              { value: "video", label: "Clip view", tip: "The video in depth: tracks, clips and effects" },
            ]}
          />
        )}
        {HeaderStart && <HeaderStart disabled={setup} />}
        <div className={styles.spacer} />
        <IconButton icon="undo-2" label="Undo" data-tip={canUndo ? "Undo the last change" : "Nothing to undo yet"} kbd="Mod+Z" disabled={!canUndo} onClick={() => useEditStudio.getState().undo()} />
        <IconButton icon="redo-2" label="Redo" data-tip={canRedo ? "Redo the change you undid" : "Nothing to redo"} kbd="Mod+Shift+Z" disabled={!canRedo} onClick={() => useEditStudio.getState().redo()} />
        {HeaderEnd && <HeaderEnd disabled={setup} />}
        <MenuButton label="More" icon="ellipsis" variant="ghost" items={moreItems} />
        <Button variant="primary" icon="download" collapsible data-tip={setup ? "Set up the song first" : `Render the ${profile.noun} to a video file`} disabled={setup} onClick={() => useEditStudio.getState().openDialog({ kind: "export" })}>
          Export
        </Button>
      </ToolHeader>

      <div className={styles.top} style={{ flex: `0 0 ${Math.round(split * 100)}%` }}>
        <Rail />
        <section
          className={styles.preview}
          onDoubleClick={() => {
            if (switchable && focus === "compose" && !setup) enterVideoFocus();
          }}
        >
          <WorkspacePreviewFrame ws={ws}>
            <div className={styles.canvasBox}>
              <EditCanvas inputs={setup ? null : inputs} width={size.width} height={size.height} timeMs={playheadMs} playing={playing} quality="draft" onStats={setStats} onCanvas={setCanvas} />
              <ErrorBoundary label="The preview overlays" compact>
                <PreviewOverlays canvas={canvas} width={size.width} height={size.height} />
              </ErrorBoundary>
            </div>
          </WorkspacePreviewFrame>
          {stats && playing && inputs && !setup && <span className={styles.stats} data-tip="Preview speed while playing: frames per second and frames that were dropped to keep up">{`${Math.round(stats.fps)} fps · ${stats.dropped} dropped`}</span>}
        </section>
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
            {Setup && <Setup />}
          </ErrorBoundary>
        </div>
      ) : (
        <div className={styles.bottom}>
          <Transport />
          <div
            className={styles.timeline}
            onDoubleClick={(e) => {
              const target = e.target as HTMLElement;
              // Double-clicking a clip clicks into the video (Edit Studio).
              if (switchable && focus === "compose" && target.closest("[data-clip-id]")) {
                enterVideoFocus();
                return;
              }
              // Double-click anywhere along the time (lanes or tracks) puts the playhead there.
              const r = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - r.left - HEADER_PX;
              if (x < 0 || target.closest("input,button,[data-trim],[role=menu]")) return;
              const st = useEditStudio.getState();
              seekTo(Math.max(0, Math.min(editLength(project), xToMs(x, st.pps, st.scrollMs))));
            }}
          >
            <ErrorBoundary label="The ruler" compact>
              <Ruler />
            </ErrorBoundary>
            {TimelineTop && (
              <ErrorBoundary label="The lanes" compact>
                <TimelineTop focus={focus} />
              </ErrorBoundary>
            )}
            <ErrorBoundary label="The timeline" compact>
              <TracksPanel />
            </ErrorBoundary>
          </div>
        </div>
      )}

      {Dialogs && <Dialogs />}
      <SongReplaceDialog />
      <ExportDialog open={dialog?.kind === "export"} onClose={() => useEditStudio.getState().openDialog(null)} />
      </ClickInHost>
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

const HEADER_H = 0; // the header lives in the shell's top bar (inline only when embedded)
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

