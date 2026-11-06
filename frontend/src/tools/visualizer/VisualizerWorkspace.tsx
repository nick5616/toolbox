/**
 * The Visualizer once a song or video is chosen (SPEC Phase 11 §5.5): one
 * screen instead of four steps.
 *
 * Header: source chip (opens the Source panel) · the design's name | undo ·
 * redo · ⋯ · Export (opens the Export panel). Rail: Analysis. Stage: the
 * designer (preview, Song Map and its rail of sections), or, while there is no
 * analysis, the analysis progress. The design and its undo history live here,
 * so they survive an analysis run.
 */
import { useEffect, useMemo, useRef } from "react";
import { Button, Icon, IconButton, MenuButton, toast, useClickIn } from "@/components";
import { useMediaSource } from "@/components/media";
import { WordsSource } from "@/lib/api";
import { PRESETS, presetById, showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { useMyPresets } from "@/blocks/visuals/designer/myPresets";
import { applyTemplate } from "@/blocks/visuals/designer/model";
import { useShowHistory, useUndoKeys } from "@/blocks/visuals/designer/useShowHistory";
import { VisualDesigner } from "@/blocks/visuals/designer/VisualDesigner";
import { Spacer, StudioLayout, WorkspacePanel, WorkspaceRail, panelDrawerId } from "@/workspace";
import AnalysisStage from "./AnalysisStage";
import { constituentItems } from "./constituents";
import { aspectValue } from "./exportPrefs";
import { basename, wordsChoiceOf } from "./source/logic";
import { analysisSummary } from "./source/summaries";
import { useVisualizer } from "./store";
import { seededShow } from "./useSeed";
import { PREVIEW_PART, visualizerWorkspace as ws } from "./workspace";
import styles from "./VisualizerWorkspace.module.css";

/** The design a new session starts from: the kept one, the seed's, or the house preset. */
export function initialShow(opts: { current: Show | null; last: Show | null | undefined; mode: "full" | "overlay" }): Show {
  if (opts.current) return opts.current;
  if (opts.last) return opts.last;
  const preset = presetById("golden-hour") ?? PRESETS[0];
  if (!preset) throw new Error("No presets are registered");
  return applyTemplate(showFromPreset(preset), { mode: opts.mode, engineText: true });
}

/** The probe is the truth about video vs audio: a file that isn't what its extension said resets the defaults. */
function useProbedKind(): void {
  const input = useVisualizer((s) => s.input);
  const isVideo = useVisualizer((s) => s.isVideo);
  const info = useMediaSource(input).source?.info;
  useEffect(() => {
    if (!input || !info) return;
    const video = !!info.video;
    if (video === isVideo) return;
    const prev = useVisualizer.getState();
    const wasGiven = wordsChoiceOf(prev.analyze.words) === "given";
    prev.setInput(input, video);
    if (wasGiven && prev.seedLines) prev.setAnalyze({ words: WordsSource.WordsGiven, lines: prev.seedLines });
  }, [input, info, isVideo]);
}

export default function VisualizerWorkspace({ lastShow }: { lastShow: Show | null }) {
  const input = useVisualizer((s) => s.input);
  const isVideo = useVisualizer((s) => s.isVideo);
  const mode = useVisualizer((s) => s.mode);
  const analysis = useVisualizer((s) => s.analysis);
  const analyze = useVisualizer((s) => s.analyze);
  const seedLook = useVisualizer((s) => s.seedLook);
  const selection = useVisualizer((s) => s.selection);
  const storePlayhead = useVisualizer((s) => s.playheadMs);
  const aspectPref = useVisualizer((s) => s.exportPrefs.aspect);
  const panelRequest = useVisualizer((s) => s.panelRequest);
  const { open } = useClickIn();

  useProbedKind();

  const history = useShowHistory(
    useMemo(() => {
      const s = useVisualizer.getState();
      const seeded = s.seedLook ? seededShow(s.seedLook, s.mode) : null;
      return seeded ?? initialShow({ current: s.show, last: lastShow, mode: s.mode });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  useUndoKeys(history);

  // A seed that arrives while the workspace is open restarts the design.
  const resetRef = useRef(history.reset);
  resetRef.current = history.reset;
  useEffect(() => {
    if (!seedLook) return;
    const seeded = seededShow(seedLook, mode);
    if (seeded) resetRef.current(seeded);
    useVisualizer.getState().setSeedLook(null);
  }, [seedLook, mode]);

  useEffect(() => {
    useVisualizer.getState().setShow(history.show);
  }, [history.show]);

  // The palette (commands) asks for a panel through the store.
  useEffect(() => {
    if (!panelRequest) return;
    open(panelDrawerId(panelRequest.id));
    useVisualizer.getState().requestPanel(null);
  }, [panelRequest, open]);

  const info = useMediaSource(isVideo && mode === "overlay" ? input : null).source?.info;
  const vw = info?.video?.width ?? 0;
  const vh = info?.video?.height ?? 0;
  const designAspect = mode === "overlay" && vw > 0 && vh > 0 ? vw / vh : aspectValue(aspectPref);
  useEffect(() => {
    useVisualizer.getState().setAspect(designAspect);
  }, [designAspect]);

  const savePreset = async (show: Show) => {
    const err = await useMyPresets.getState().add(show);
    toast(err ? { title: err, tone: "danger" } : { title: `Saved "${show.name}" to My presets`, tone: "success" });
  };

  if (!input) return null;
  return (
    <StudioLayout
      className={styles.studio}
      header={
        <>
          <button type="button" className={styles.chip} data-tip={`${input} (open the source panel)`} aria-label={`Source: ${basename(input)}`} onClick={() => open(panelDrawerId("source"))}>
            <Icon name={isVideo ? "film" : "music"} size={14} />
            <span className={styles.chipName}>{basename(input)}</span>
          </button>
          <span className={styles.name} data-tip="The name of this design">
            {history.show.name}
          </span>
          <Spacer />
          <IconButton icon="undo-2" label="Undo" data-tip="Undo the last design change" kbd="Mod+Z" disabled={!history.canUndo} onClick={history.undo} />
          <IconButton icon="redo-2" label="Redo" data-tip="Redo the change you just undid" kbd="Mod+Shift+Z" disabled={!history.canRedo} onClick={history.redo} />
          <MenuButton label="More" icon="ellipsis" variant="ghost" tip="Open this song in Stems or BPM & Key, here or in their own window" items={() => constituentItems(input)} />
          <Button
            variant="primary"
            icon="film"
            collapsible
            disabled={!analysis}
            data-tip={analysis ? "Choose the size and quality and render the video" : "Analyse the song first"}
            onClick={() => open(panelDrawerId("export"))}
          >
            Export
          </Button>
        </>
      }
      rail={
        <>
          <WorkspaceRail ws={ws} panels={["analysis"]} summaries={{ analysis: analysisSummary(analyze) }} />
          {/* Opened by the source chip and the Export button; their drawers stay mounted. */}
          <span hidden>
            <WorkspacePanel ws={ws} panel="source" />
            <WorkspacePanel ws={ws} panel="export" />
          </span>
        </>
      }
      stage={
        analysis ? (
          <div className={styles.designer}>
            <VisualDesigner
              inputPath={input}
              analysis={analysis}
              show={history.show}
              onChange={history.set}
              aspect={designAspect}
              mode={mode}
              player={null}
              text="engine"
              selection={selection}
              onSelect={useVisualizer.getState().setSelection}
              onPlayhead={useVisualizer.getState().setPlayheadMs}
              previewPart={PREVIEW_PART}
              windowPlayheadMs={storePlayhead}
              onSavePreset={(s) => void savePreset(s)}
            />
          </div>
        ) : (
          <AnalysisStage key={input} />
        )
      }
    />
  );
}
