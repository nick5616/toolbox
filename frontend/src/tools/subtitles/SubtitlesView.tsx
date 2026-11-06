/**
 * Subtitles (Phase 11, SPEC §5.3): a drop zone until a source is chosen, then
 * one workspace screen: header (source, language, undo/redo, Export), a rail of
 * panels (Transcription, Translate, Style, Export), the picture with the
 * current subtitle, and the cue list. All state is in `store.ts`.
 */
import { useMemo } from "react";
import { Banner, Button, ClickInHost, ConfirmDialog, DropZone, Icon, IconButton, MenuButton, useClickIn, type MenuItem } from "@/components";
import { languageName, speechSummary } from "@/blocks/speech";
import { useToolHandoff } from "@/lib/embed";
import { useShortcut } from "@/lib/shortcuts";
import { useCompositionInputs } from "@/state/composition";
import type { ToolViewProps } from "@/tools";
import { Spacer, StudioLayout, WorkspacePanel, WorkspacePreviewFrame, WorkspaceRail, panelDrawerId } from "@/workspace";
import { PartFrame } from "@/parts/PartFrame";
import { CuesPanel } from "./CuesPanel";
import { DesignerSheet } from "./DesignerSheet";
import { MediaCtx, useHostMedia, useJobWatcher, usePrefsPersistence } from "./host";
import { useBlocker, useRows } from "./hooks";
import { anyDirty } from "./editor";
import { basename } from "./logic";
import { canvasAspect, speechOf } from "./options";
import { SubtitlesPreview } from "./Preview";
import { useSessionTransfer } from "./session";
import { RunStatus } from "./RunStatus";
import { useRun } from "./runs";
import { MODULE_ID, useSubtitles } from "./store";
import { cuesToLines, defaultVisuals } from "./visuals";
import { subtitlesWorkspace as ws } from "./workspace";
import styles from "./SubtitlesView.module.css";

function EmptyDrop() {
  const loadError = useSubtitles((s) => s.loadError);
  const pickMedia = useSubtitles((s) => s.pickMedia);
  const pickSubtitleFile = useSubtitles((s) => s.pickSubtitleFile);
  return (
    <div className={styles.sourceEmpty}>
      {loadError && (
        <Banner tone="danger" title="Couldn't read the subtitles">
          {loadError}
        </Banner>
      )}
      <DropZone id="tool-drop:subtitles" icon="captions" label="Drop a video, an audio file, or an .srt / .vtt" hint="Generate subtitles from speech, or edit ones you already have.">
        <div className={styles.buttonRow}>
          <Button icon="plus" onClick={() => void pickMedia()} data-tip="Pick a video or audio file to generate subtitles from its speech">
            Choose a video or audio file…
          </Button>
          <Button variant="secondary" icon="file-text" onClick={() => void pickSubtitleFile()} data-tip="Open an .srt or .vtt file you already have to edit it">
            Use a subtitle file…
          </Button>
        </div>
      </DropZone>
    </div>
  );
}

/** What the stage shows before any subtitles exist: the primary action over the picture. */
function GenerateCta() {
  const prefs = useSubtitles((s) => s.prefs);
  const spoken = useSubtitles((s) => s.spoken);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const mediaStatus = useSubtitles((s) => s.media.status);
  const generate = useSubtitles((s) => s.generate);
  const pickSubtitleFile = useSubtitles((s) => s.pickSubtitleFile);
  const gen = useRun("gen");
  const extract = useRun("extract");
  const busy = gen.busy || extract.busy;
  return (
    <div className={styles.cta}>
      <div className={styles.ctaCard}>
        <Button variant="primary" icon="captions" onClick={generate} loading={gen.busy} disabled={!mediaPath || busy || mediaStatus === "error"} data-tip={busy ? "Wait for the current task to finish" : "Listen to the speech and write subtitles for it"}>
          Generate subtitles
        </Button>
        <span className={styles.ctaSummary} data-tip="Change these in the Transcription panel">
          {speechSummary(speechOf(prefs), spoken)}
        </span>
        <Button variant="ghost" size="sm" icon="file-text" disabled={busy} onClick={() => void pickSubtitleFile()} data-tip="Open an .srt or .vtt file you already have, to edit it">
          Use a subtitle file…
        </Button>
        <RunStatus run={gen} runningLabel="Listening for speech…" showResult={false} />
      </div>
    </div>
  );
}

function Workspace() {
  const { open } = useClickIn();
  const prefs = useSubtitles((s) => s.prefs);
  const spoken = useSubtitles((s) => s.spoken);
  const languages = useSubtitles((s) => s.languages);
  const styleInfos = useSubtitles((s) => s.styleInfos);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const subPath = useSubtitles((s) => s.subPath);
  const editor = useSubtitles((s) => s.editor);
  const sourceLang = useSubtitles((s) => s.sourceLang);
  const undo = useSubtitles((s) => s.undo);
  const redo = useSubtitles((s) => s.redo);
  const save = useSubtitles((s) => s.save);
  const startOver = useSubtitles((s) => s.startOver);
  const pickMedia = useSubtitles((s) => s.pickMedia);
  const pickSubtitleFile = useSubtitles((s) => s.pickSubtitleFile);
  const openInVisualizer = useSubtitles((s) => s.openInVisualizer);
  const hasCues = editor.tabs.length > 0;
  const tab = editor.tabs.find((t) => t.id === editor.activeId);
  const dirty = anyDirty(editor);
  const canUndo = (tab?.history.past.length ?? 0) > 0;
  const canRedo = (tab?.history.future.length ?? 0) > 0;
  const blocker = useBlocker();
  const saveRun = useRun("save");

  const sourceName = mediaPath ? basename(mediaPath) : subPath ? basename(subPath) : "Choose a file";
  const sourceTip = mediaPath ?? subPath ?? "Choose the video, audio or subtitle file";
  const languageText = tab ? (tab.language ? languageName(tab.language, languages.length > 0 ? languages : spoken) : tab.label) : languageName(prefs.language, spoken);

  const summaries = useMemo(() => {
    const from = sourceLang ?? editor.tabs[0]?.language ?? "";
    const fromName = from ? (languages.find((l) => l.code === from)?.name ?? from.toUpperCase()) : "Unknown";
    const toName = prefs.targetLanguage ? (languages.find((l) => l.code === prefs.targetLanguage)?.name ?? prefs.targetLanguage.toUpperCase()) : "";
    return {
      transcription: speechSummary(speechOf(prefs), spoken),
      translate: toName ? `${fromName} → ${toName}` : "Not set",
      style: styleInfos.find((s) => s.id === prefs.style)?.label ?? prefs.style,
      export: prefs.formats.map((f) => f.toUpperCase()).join(" + "),
    };
  }, [prefs, spoken, languages, styleInfos, sourceLang, editor.tabs]);

  const state = saveRun.busy ? "Saving…" : dirty ? "Unsaved" : "";

  // The designer sheet has its own undo and Esc handling while it is open.
  const designerOpen = useSubtitles((s) => s.designerOpen);
  useShortcut("Mod+Z", undo, { when: hasCues && !designerOpen, allowInInputs: true });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], redo, { when: hasCues && !designerOpen, allowInInputs: true });
  useShortcut("Mod+S", () => save(), { when: hasCues && !designerOpen, allowInInputs: true });

  const menu = (): MenuItem[] => [
    { id: "save", label: "Save subtitles", icon: "check", tip: blocker ?? "Write the subtitles to a file in your Library", disabled: !hasCues || blocker !== null || saveRun.busy, onSelect: () => save() },
    { id: "lang", label: `Language: ${languageText}`, icon: "languages", tip: "The language of these subtitles (opens Translate)", onSelect: () => open(panelDrawerId("translate")) },
    { id: "file", label: "Use a subtitle file…", icon: "file-text", tip: "Open an .srt or .vtt file to edit", onSelect: () => void pickSubtitleFile() },
    { id: "media", label: mediaPath ? "Choose a different video or audio file…" : "Pick the video…", icon: "film", tip: "Choose the picture to preview and burn the subtitles onto", onSelect: () => void pickMedia() },
    { id: "viz", label: "Make it fully reactive in Visualizer", icon: "sparkles", tip: "Open Visualizer with this audio and these words", disabled: !mediaPath, onSelect: () => openInVisualizer() },
    { id: "vizw", label: "Open Visualizer in its own window", icon: "app-window", tip: "Open Visualizer with this in its own window", disabled: !mediaPath, onSelect: () => openInVisualizer(true) },
    { id: "over", label: "Start over", icon: "trash-2", tip: "Discard these subtitles and begin again", onSelect: startOver },
  ];

  const header = (
    <>
      <button type="button" className={styles.headChip} onClick={() => open(panelDrawerId("source"))} data-tip={`${sourceTip} (opens the Source panel)`}>
        <Icon name={mediaPath ? "film" : "file-text"} size={14} />
        <span className={styles.headChipText}>{sourceName}</span>
      </button>
      {state && (
        <span className={styles.state}>
          {dirty && !saveRun.busy && <span className={styles.dot} role="img" aria-label="Unsaved changes" data-tip="You have edits that aren't saved yet" />}
          {state}
        </span>
      )}
      <Spacer />
      <IconButton size="sm" icon="undo-2" label="Undo" data-tip="Undo the last subtitle edit" kbd="Mod+Z" disabled={!canUndo} onClick={undo} />
      <IconButton size="sm" icon="redo-2" label="Redo" data-tip="Redo the edit you just undid" kbd="Mod+Shift+Z" disabled={!canRedo} onClick={redo} />
      <MenuButton label="More" icon="ellipsis" variant="ghost" tip="Save, change the file, open in Visualizer, start over" items={menu} />
      <Button size="sm" icon="download" onClick={() => open(panelDrawerId("export"))} data-tip="Save files, add a track to the video or burn the text into the picture">
        Export
      </Button>
      {/* The Source panel has no rail launcher (the source chip opens it), so its drawer stays mounted here. */}
      <span hidden>
        <WorkspacePanel ws={ws} panel="source" variant="icon" />
      </span>
    </>
  );

  return (
    <StudioLayout
      header={header}
      rail={<WorkspaceRail ws={ws} panels={["transcription", "translate", "style", "export"]} summaries={summaries} />}
      stage={
        <div className={styles.stage}>
          <WorkspacePreviewFrame ws={ws}>
            <SubtitlesPreview />
          </WorkspacePreviewFrame>
          {!hasCues && <GenerateCta />}
        </div>
      }
      side={
        hasCues ? (
          <PartFrame part={ws.panelPart} instance="cues" params={{ panel: "cues" }}>
            <CuesPanel />
          </PartFrame>
        ) : undefined
      }
      sideWidth={360}
    />
  );
}

export default function SubtitlesView({ moduleId }: ToolViewProps) {
  ws.useHost();
  useJobWatcher();
  usePrefsPersistence();
  useSessionTransfer();
  const media = useHostMedia();
  useToolHandoff(moduleId, (h) => useSubtitles.getState().handleInputs(h.inputs));

  const mediaPath = useSubtitles((s) => s.mediaPath);
  const open = useSubtitles((s) => s.mediaPath !== null || s.editor.tabs.length > 0);
  const designerOpen = useSubtitles((s) => s.designerOpen);
  const pendingConfirm = useSubtitles((s) => s.pendingConfirm);
  const confirmPending = useSubtitles((s) => s.confirmPending);
  const cancelPending = useSubtitles((s) => s.cancelPending);
  useCompositionInputs(MODULE_ID, { trimmer: mediaPath ? [mediaPath] : [], visualizer: mediaPath ? [mediaPath] : [] });

  return (
    <MediaCtx.Provider value={media}>
      <ClickInHost className={styles.root}>
        {open ? <Workspace /> : <EmptyDrop />}
        {designerOpen && mediaPath && <Designer path={mediaPath} />}
        <ConfirmDialog
          open={pendingConfirm !== null}
          title={pendingConfirm?.title ?? ""}
          body={pendingConfirm?.body}
          confirmLabel={pendingConfirm?.label ?? "OK"}
          tone="danger"
          onConfirm={confirmPending}
          onCancel={cancelPending}
        />
      </ClickInHost>
    </MediaCtx.Provider>
  );
}

/** The full designer in a sheet over the workspace; the cues are drawn as the burn-style text (SPEC.md 9.3). */
function Designer({ path }: { path: string }) {
  const rows = useRows();
  const prefs = useSubtitles((s) => s.prefs);
  const media = useSubtitles((s) => s.media);
  const chosen = useSubtitles((s) => s.chosen);
  const selection = useSubtitles((s) => s.designerSelection);
  const setSelection = useSubtitles((s) => s.setDesignerSelection);
  const setPlayhead = useSubtitles((s) => s.setDesignerPlayhead);
  const designerDone = useSubtitles((s) => s.designerDone);
  const closeDesigner = useSubtitles((s) => s.closeDesigner);
  const mode = media.isVideo ? "overlay" : "background";
  const value = useMemo(() => chosen ?? defaultVisuals(mode), [chosen, mode]);
  const lines = useMemo(() => cuesToLines(rows), [rows]);
  if (!value) return null;
  const aspect = media.isVideo ? (media.height > 0 ? media.width / media.height : 16 / 9) : canvasAspect(prefs.canvas);
  return (
    <DesignerSheet
      inputPath={path}
      rows={rows}
      lines={lines}
      value={value}
      mode={mode}
      aspect={aspect}
      prefs={prefs}
      selection={selection}
      onSelect={setSelection}
      onPlayhead={setPlayhead}
      onDone={designerDone}
      onClose={closeDesigner}
    />
  );
}
