/**
 * Color Grader (Phase 21 SPEC Part E): film looks to absolutely unhinged.
 * A workspace tool: the preview with a before/after split in the middle, the
 * look gallery along the bottom, the Wildness dial and Export in the header,
 * and the rail of click-ins (files, look, vibe, read, regions, steal, chaos,
 * motion, export) on the left.
 */
import { useEffect, useMemo, useRef } from "react";
import { FromLibraryButton } from "@/blocks/library-picker";
import { Button, ClickInHost, EmptyState, MenuButton } from "@/components";
import { SettingsService } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useToolHandoff } from "@/lib/embed";
import { openLibrary } from "@/lib/openLibrary";
import { useShortcut } from "@/lib/shortcuts";
import type { ToolViewProps } from "@/lib/toolActions";
import { Spacer, StudioLayout, WorkspacePreviewFrame, WorkspaceRail } from "@/workspace";
import { DepsGate } from "../_kit/DepsGate";
import { addPaths, exportAll, loadMine, openInput, pickFiles, pickLibraryFiles } from "./actions";
import { Gallery } from "./Gallery";
import { disposeThumbs } from "./lookThumbs";
import { GradePreview, useGradeClock } from "./Preview";
import { recipeSummary } from "./recipe";
import { ALL_EXTS, MODULE_ID, baseName, useGrade, type GalleryTab, type OutputFormat } from "./store";
import { Wildness } from "./Wildness";
import { gradeWorkspace as ws } from "./workspace";
import styles from "./Grade.module.css";

const PANELS = ["files", "look", "vibe", "read", "regions", "steal", "chaos", "motion", "export"] as const;

interface Saved {
  wild?: number;
  format?: OutputFormat;
  tab?: GalleryTab;
}

function useRemembered(): void {
  const wild = useGrade((s) => s.wild);
  const format = useGrade((s) => s.format);
  const tab = useGrade((s) => s.tab);
  const loaded = useRef(false);
  useEffect(() => {
    let live = true;
    SettingsService.ModuleState(MODULE_ID)
      .then((raw) => {
        if (!live || !raw) return;
        const v = JSON.parse(raw) as Saved;
        const st = useGrade.getState();
        if (typeof v.wild === "number") st.setWild(v.wild);
        if (v.format === "same" || v.format === "jpg" || v.format === "png" || v.format === "webp") st.setFormat(v.format);
        if (v.tab === "film" || v.tab === "bold" || v.tab === "bonkers" || v.tab === "mine") st.setTab(v.tab);
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => void SettingsService.SetModuleState(MODULE_ID, JSON.stringify({ wild, format, tab })).catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [wild, format, tab]);
}

function summaries(): Record<string, string> {
  const s = useGrade.getState();
  return {
    files: s.inputs.length === 0 ? "No files" : `${s.inputs.length} ${s.inputs.length === 1 ? "file" : "files"}`,
    look: recipeSummary(s.recipe),
  };
}

export default function GradeView({ moduleId }: ToolViewProps) {
  ws.useHost();
  useGradeClock();
  useRemembered();
  const selected = useGrade((s) => s.selected);
  const inputs = useGrade((s) => s.inputs);
  const recipe = useGrade((s) => s.recipe);
  const vibe = useGrade((s) => s.vibe);
  const vibeText = useGrade((s) => s.vibeText);
  const read = useGrade((s) => s.read);
  const suggestions = useGrade((s) => s.suggestions);
  const maps = useGrade((s) => s.maps);
  const seed = useGrade((s) => s.chaosSeed);
  const video = useGrade((s) => s.src?.info.kind === "video");
  const animated = useGrade((s) => s.recipe.ops.filter((o) => o.anim).length);
  const format = useGrade((s) => s.format);
  const exporting = useGrade((s) => s.exporting);

  useToolHandoff(moduleId, (h) => void addPaths(h.inputs));
  useEffect(() => {
    void loadMine();
    return () => disposeThumbs();
  }, []);
  useEffect(() => {
    if (selected) void openInput(selected);
  }, [selected]);
  useShortcut("Space", () => useGrade.getState().setPlaying(!useGrade.getState().playing), { when: !!video && !!selected });

  useCommands(
    [
      { id: "tool.addFiles", title: "Add files…", section: "Actions", shortcut: "Mod+O", icon: "plus", run: () => void pickFiles() },
      { id: "grade.addFromLibrary", title: "Add files from Library…", section: "Actions", icon: "folder-open", run: () => void pickLibraryFiles() },
      { id: "grade.surprise", title: "Color Grader: Surprise me", section: "Actions", icon: "dices", run: () => useGrade.getState().surprise(Math.floor(Math.random() * 100000)) },
    ],
    [],
  );

  const ready = (maps?.depth.ready ? 1 : 0) + (maps?.subject.ready ? 1 : 0) + (maps?.people.ready ? 1 : 0);
  const sum = useMemo<Record<string, string>>(
    () => ({
      ...summaries(),
      vibe: vibe.phase === "busy" ? "Writing a look…" : vibeText.trim() ? vibeText.trim().slice(0, 40) : "Describe a look",
      read: read.phase === "busy" ? "Looking…" : suggestions.length > 0 ? `${suggestions.length} suggestions` : "6 looks for this picture",
      regions: !selected ? "Open a file first" : ready > 0 ? `${ready} of 3 maps ready` : "No maps made yet",
      steal: "Match a reference picture",
      chaos: `Seed #${seed}`,
      motion: !video ? "Videos only" : animated > 0 ? `${animated} moving` : "Nothing moving",
      export: format === "same" ? "Graded folder" : `Pictures as ${format.toUpperCase()}`,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputs, recipe, vibe.phase, vibeText, read.phase, suggestions.length, selected, ready, seed, video, animated, format],
  );

  const exportWhy = inputs.length === 0 ? "Add a picture or a video first" : "";
  const header = (
    <>
      <span className={styles.headTitle} data-tip={selected || "No file open"}>
        {selected ? baseName(selected) : "No file"}
      </span>
      <Wildness />
      <Spacer />
      <MenuButton
        label="More"
        icon="ellipsis"
        variant="ghost"
        data-tip="Add files, open the Library, or clear the batch"
        items={() => [
          { id: "add", label: "Add files…", icon: "plus", onSelect: () => void pickFiles() },
          { id: "lib", label: "Add from Library…", icon: "folder-open", onSelect: () => void pickLibraryFiles() },
          { id: "show", label: "Show Color Grader's files in Library", icon: "folder-open", onSelect: () => openLibrary({ moduleId: MODULE_ID }) },
          { id: "clear", label: "Clear the batch", icon: "x", onSelect: () => useGrade.getState().clearInputs() },
        ]}
      />
      <Button
        variant="primary"
        size="sm"
        icon="download"
        data-testid="grade-export"
        loading={exporting}
        aria-disabled={!!exportWhy || undefined}
        data-tip={exportWhy || "Grade every file with this look and save the results to the Graded folder of your Library"}
        onClick={() => !exportWhy && void exportAll()}
      >
        Export
      </Button>
    </>
  );

  return (
    <ClickInHost className={styles.view}>
      <StudioLayout
        header={header}
        rail={<WorkspaceRail ws={ws} panels={PANELS} summaries={sum} />}
        stage={
          <div className={styles.stage}>
            <DepsGate moduleId={moduleId} />
            <div className={styles.stageBody}>
              {selected ? (
                <WorkspacePreviewFrame ws={ws}>
                  <GradePreview />
                </WorkspacePreviewFrame>
              ) : (
                <div className={styles.previewEmpty}>
                  <EmptyState
                    icon="palette"
                    size="lg"
                    title="Color Grader"
                    body="Film looks to absolutely unhinged. Drop pictures or videos here, or add some."
                    action={
                      <div className={styles.actions}>
                        <Button variant="primary" icon="plus" kbd="Mod+O" data-tip="Choose pictures or videos to grade" onClick={() => void pickFiles()}>
                          Add files…
                        </Button>
                        <FromLibraryButton title="Choose pictures or videos from Library" exts={ALL_EXTS} multiple onPick={(p) => void addPaths(p)} />
                      </div>
                    }
                  />
                </div>
              )}
            </div>
          </div>
        }
        bottom={<Gallery />}
      />
    </ClickInHost>
  );
}
