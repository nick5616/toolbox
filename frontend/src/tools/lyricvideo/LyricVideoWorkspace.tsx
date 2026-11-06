/**
 * Lyric Video once a song is chosen (SPEC Phase 11 §5.4): one screen instead of
 * five steps.
 *
 * Header: song chip (opens Song) | undo · redo · ⋯ · Export (opens Export).
 * Rail: Song, Lyrics, Visuals, Look. Stage: the preview (a part that pops
 * out) with the song's player and timeline under it, or the full designer when
 * it is open. Side: the lyric lines (a panel that pops out).
 *
 * This component owns what needs the live window: the audio player, the media
 * info, the listening (visuals analysis) and the design's undo history. The
 * panels read the store.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ConfirmDialog, Icon, IconButton, MenuButton, useClickIn } from "@/components";
import { MediaPlayer, Timeline, useMediaSource, type Marker } from "@/components/media";
import { useVisualsAnalysis } from "@/components/viz/useVisualsAnalysis";
import { LyricSource, MediaService, VisualizerService } from "@/lib/api";
import { openToolItems } from "@/lib/openTool";
import { useShortcut } from "@/lib/shortcuts";
import { useJob } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { PartFrame } from "@/parts/PartFrame";
import { withoutText } from "@/blocks/visuals/designer/model";
import { useShowHistory } from "@/blocks/visuals/designer/useShowHistory";
import { VisualDesigner } from "@/blocks/visuals/designer/VisualDesigner";
import type { Show } from "@/viz/types";
import { JobStatus } from "@/lib/api";
import { Spacer, StudioLayout, WorkspacePanel, WorkspaceRail, panelDrawerId } from "@/workspace";
import { makeInVisualizer } from "./actions";
import { useEngineGate } from "./engine";
import { basename, stem, tagValue, toLines, toRows } from "./logic";
import { parseResult, textSummary } from "./options";
import { LyricOverlay } from "./Preview";
import { PreviewStage } from "./PreviewPart";
import { designHandle, playerHandle, useLyricVideo } from "./store";
import { STEMS_MODEL, aspectNumber, componentInstalled, designLabel, initialDesign, showOf, stepAnalyzeOptions } from "./visuals";
import { lyricVideoWorkspace as ws } from "./workspace";
import styles from "./panels.module.css";

/** Follows the "Get timings" job: its result becomes the sheet, even while the Lyrics panel is closed. */
function useGenResult(): void {
  const id = useLyricVideo((s) => s.jobIds.gen);
  const job = useJob(id);
  const handled = useRef("");
  useEffect(() => {
    if (!job || job.status !== JobStatus.JobDone || handled.current === job.id) return;
    handled.current = job.id;
    const r = parseResult(job.resultJson);
    if (!r) return;
    const s = useLyricVideo.getState();
    s.resetSheet(toRows(r.lines));
    s.setNoLyrics((r.lines ?? []).length === 0);
    s.setHasInstrumental(r.hasInstrumental);
    const aligned = s.prefs.source === LyricSource.SourceAlign || (s.prefs.source === LyricSource.SourceFile && /\.txt$/i.test(s.lyricsPath));
    s.setMatched(aligned ? r.matched : null);
  }, [job]);
}

/** The song's media: duration, cover art, waveform and the title/artist from its tags. */
function useSongMedia(songPath: string): { waveform: number[] | undefined; media: ReturnType<typeof useMediaSource> } {
  const media = useMediaSource(songPath);
  const info = media.source?.info;
  const ready = media.status === "ready" && !!media.source;
  const hasCover = !!info?.hasCover;
  const durationMs = info?.durationMs ?? 0;
  const [waveform, setWaveform] = useState<number[] | undefined>(undefined);

  useEffect(() => {
    useLyricVideo.getState().setMedia({ mediaReady: ready, durationMs, hasCover });
  }, [ready, durationMs, hasCover]);

  useEffect(() => {
    useLyricVideo.getState().setMedia({ coverUrl: undefined });
    setWaveform(undefined);
    if (!ready) return;
    let off = false;
    if (hasCover) MediaService.Frame(songPath, 0, 640).then((u) => !off && useLyricVideo.getState().setMedia({ coverUrl: u })).catch(() => undefined);
    MediaService.Waveform(songPath, 800).then((w) => !off && setWaveform(w ?? undefined)).catch(() => undefined);
    return () => {
      off = true;
    };
  }, [songPath, ready, hasCover]);

  // A remembered session keeps its (possibly edited) title and artist.
  const metaFor = useRef(useLyricVideo.getState().meta.title !== "" ? songPath : "");
  useEffect(() => {
    if (!info || metaFor.current === songPath) return;
    metaFor.current = songPath;
    useLyricVideo.getState().setMeta({ title: tagValue(info.tags, "title") || stem(songPath), artist: tagValue(info.tags, "artist") });
  }, [songPath, info]);

  const bg = useLyricVideo((s) => s.prefs.look.background);
  const bgPath = useLyricVideo((s) => s.prefs.look.backgroundPath);
  useEffect(() => {
    useLyricVideo.getState().setMedia({ imageUrl: undefined });
    if (bg !== "image" || !bgPath) return;
    let off = false;
    MediaService.URLFor(bgPath).then((u) => !off && useLyricVideo.getState().setMedia({ imageUrl: u })).catch(() => undefined);
    return () => {
      off = true;
    };
  }, [bg, bgPath]);

  return { waveform, media };
}

/** The listening (one analyze job with the sheet as given words) that feeds the visuals; it is published to the store. */
function useListening(songPath: string): void {
  const prefs = useLyricVideo((s) => s.prefs);
  const rows = useLyricVideo((s) => s.rows);
  const saveStems = useLyricVideo((s) => s.saveStems);
  const engaged = useLyricVideo((s) => s.visualsEngaged);
  const packs = usePacks((s) => s.list);
  const gate = useEngineGate("visuals");
  const [moodChecked, setMoodChecked] = useState(false);
  const [moodReady, setMoodReady] = useState(false);
  useEffect(() => {
    let alive = true;
    VisualizerService.MoodReaderReady()
      .then((ok) => alive && setMoodReady(Boolean(ok)))
      .catch(() => undefined)
      .finally(() => alive && setMoodChecked(true));
    return () => {
      alive = false;
    };
  }, []);
  const look = prefs.look;
  const stemsOn = look.visuals.stems && componentInstalled(packs, STEMS_MODEL);
  const lines = useMemo(() => toLines(rows), [rows]);
  const analyze = useMemo(
    () => stepAnalyzeOptions({ stems: stemsOn, saveStems, useWords: look.visuals.useWords, lines, moodReady }),
    [stemsOn, saveStems, look.visuals.useWords, lines, moodReady],
  );
  const visualsOn = look.background === "visualizer";
  const wanted = (engaged && prefs.visualsMode !== "classic") || visualsOn;
  const listening = useVisualsAnalysis(wanted ? songPath : null, { analyze, auto: engaged && prefs.visualsMode !== "classic" && moodChecked && !gate.blocked });
  const instrumentalRef = listening.ref?.instrumental;
  useEffect(() => {
    if (instrumentalRef) useLyricVideo.getState().setHasInstrumental(true);
  }, [instrumentalRef]);
  const published = useMemo(
    () => listening,
    // The hook returns a new object each render; its parts decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listening.status, listening.progress, listening.stage, listening.ref, listening.analysis, listening.error, listening.start, listening.cancel],
  );
  useEffect(() => {
    useLyricVideo.getState().setListening(published);
  }, [published]);
  useEffect(() => () => useLyricVideo.getState().setListening(null), []);
}

/** The full designer on the stage, with this tool's own words drawn over its canvas. */
function DesignerStage({ songPath, history }: { songPath: string; history: ReturnType<typeof useShowHistory> }) {
  const analysis = useLyricVideo((s) => s.listening?.analysis ?? null);
  const status = useLyricVideo((s) => s.listening?.status ?? "idle");
  const prefs = useLyricVideo((s) => s.prefs);
  const rows = useLyricVideo((s) => s.rows);
  const meta = useLyricVideo((s) => s.meta);
  const lyricLook = useMemo(() => ({ ...prefs.look, title: meta.title, artist: meta.artist }), [prefs.look, meta]);
  return (
    <div className={styles.designer}>
      <div className={styles.designerBar}>
        <span className={styles.designerName} data-tip="The name of this design">
          {history.show.name}
        </span>
        <Button size="sm" variant="ghost" icon="monitor" onClick={() => useLyricVideo.getState().setDesignerOpen(false)} data-tip="Back to the preview with the words">
          Show the preview
        </Button>
      </div>
      {analysis ? (
        <VisualDesigner
          inputPath={songPath}
          analysis={analysis}
          show={history.show}
          onChange={history.set}
          aspect={aspectNumber(prefs.aspect)}
          mode="full"
          player={null}
          text={{ overlay: (_rect, timeMs) => <LyricOverlay look={lyricLook} rows={rows} ms={timeMs} /> }}
          tabs={["presets", "look", "reactions", "layers", "timeline"]}
        />
      ) : (
        <Banner tone="info" title={status === "running" || status === "checking" ? "The designer opens once the song has been listened to." : "The designer needs the song to be listened to first."} />
      )}
    </div>
  );
}

/**
 * The design's history, kept in step with the options (the picker and the
 * designer both choose the design). Its steps are mirrored into the store's
 * single undo journal, so the header's Undo takes back the last change
 * whether it was to the lines or the design.
 */
function useDesign() {
  const showJson = useLyricVideo((s) => s.prefs.look.visuals.showJson);
  const designerOpen = useLyricVideo((s) => s.designerOpen);
  const history = useShowHistory(
    useMemo(() => {
      const own = showOf(useLyricVideo.getState().prefs.look.visuals);
      return (own ?? initialDesign()) as Show;
      // The design a session starts from is read once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const live = useRef(history);
  live.current = history;
  useEffect(() => {
    // A design history from an earlier mount is gone; its steps can't be taken back.
    useLyricVideo.getState().dropDomain("design");
    designHandle.current = { undo: () => live.current.undo(), redo: () => live.current.redo() };
    return () => {
      designHandle.current = null;
    };
  }, []);
  const seq = useRef(history.seq);
  useEffect(() => {
    if (history.seq === seq.current) return;
    seq.current = history.seq;
    useLyricVideo.getState().noteStep("design");
  }, [history.seq]);
  const epoch = useRef(history.epoch);
  useEffect(() => {
    if (history.epoch === epoch.current) return;
    epoch.current = history.epoch;
    useLyricVideo.getState().dropDomain("design");
  }, [history.epoch]);
  const emitted = useRef(showJson);
  // The designer's edits become the chosen design.
  useEffect(() => {
    if (!designerOpen) return;
    const json = JSON.stringify(withoutText(history.show));
    if (json === emitted.current) return;
    emitted.current = json;
    useLyricVideo.getState().setPrefs((o) => ({ ...o, look: { ...o.look, background: "visualizer", visuals: { ...o.look.visuals, showJson: json } } }));
  }, [history.show, designerOpen]);
  // A design chosen elsewhere (the quick picker) restarts the designer's history.
  const resetRef = useRef(history.reset);
  resetRef.current = history.reset;
  useEffect(() => {
    if (showJson === emitted.current || showJson === "") return;
    emitted.current = showJson;
    const s = showOf(useLyricVideo.getState().prefs.look.visuals);
    if (s) resetRef.current(s);
  }, [showJson]);
  return history;
}

export default function LyricVideoWorkspace() {
  const songPath = useLyricVideo((s) => s.songPath);
  if (!songPath) return null;
  return <Workspace key={songPath} songPath={songPath} />;
}

function Workspace({ songPath }: { songPath: string }) {
  const meta = useLyricVideo((s) => s.meta);
  const prefs = useLyricVideo((s) => s.prefs);
  const rowsCount = useLyricVideo((s) => s.rows.length);
  const canUndo = useLyricVideo((s) => s.canUndo);
  const canRedo = useLyricVideo((s) => s.canRedo);
  const tapIndex = useLyricVideo((s) => s.tapIndex);
  const designerOpen = useLyricVideo((s) => s.designerOpen);
  const pendingSong = useLyricVideo((s) => s.pendingSong);
  const panelRequest = useLyricVideo((s) => s.panelRequest);
  const selectedId = useLyricVideo((s) => s.selectedId);
  const rows = useLyricVideo((s) => s.rows);
  const playheadMs = useLyricVideo((s) => s.playheadMs);
  const durationMs = useLyricVideo((s) => s.durationMs);
  const { open } = useClickIn();
  const st = useLyricVideo.getState;
  const tapping = tapIndex >= 0;

  useGenResult();
  useListening(songPath);
  const design = useDesign();
  const { waveform, media } = useSongMedia(songPath);

  // The palette (commands) and the Look panel ask for a panel through the store.
  useEffect(() => {
    if (!panelRequest) return;
    open(panelDrawerId(panelRequest.id));
    useLyricVideo.getState().requestPanel(null);
  }, [panelRequest, open]);

  // One undo history for the lines and the design. While the designer is open its own text fields keep their native undo.
  useShortcut("Mod+Z", () => st().undo(), { when: !tapping, allowInInputs: !designerOpen });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => st().redo(), { when: !tapping, allowInInputs: !designerOpen });
  // Tap to sync.
  useShortcut(" ", () => st().stamp(), { when: tapping });
  useShortcut("Backspace", () => st().tapBackOne(), { when: tapping });
  useShortcut("Escape", () => st().endTap(), { when: tapping });

  const markers: Marker[] = useMemo(() => rows.map((r) => ({ id: r.id, startMs: r.startMs, endMs: r.endMs, label: r.text, tone: r.id === selectedId ? ("accent" as const) : ("neutral" as const) })), [rows, selectedId]);
  const label = [meta.title, meta.artist].filter(Boolean).join(" — ") || basename(songPath);
  const linesPanel = ws.getPanel("lines");
  const Lines = linesPanel?.component;

  return (
    <>
      <StudioLayout
        className={styles.studio}
        sideWidth={360}
        header={
          <>
            <button type="button" className={styles.chip} data-tip={`${songPath} (open the song panel)`} aria-label={`Song: ${label}`} onClick={() => open(panelDrawerId("song"))}>
              <Icon name="music" size={14} />
              <span className={styles.chipName}>{label}</span>
            </button>
            <Spacer />
            <IconButton icon="undo-2" label="Undo" data-tip="Undo the last change to the lyrics or the design" kbd="Mod+Z" disabled={!canUndo} onClick={() => st().undo()} />
            <IconButton icon="redo-2" label="Redo" data-tip="Redo the change you just undid" kbd="Mod+Shift+Z" disabled={!canRedo} onClick={() => st().redo()} />
            <MenuButton
              label="More"
              icon="ellipsis"
              variant="ghost"
              tip="Open this song in Stems, Transcribe or the Visualizer, here or in their own window"
              items={() => [
                ...openToolItems("stems", [songPath], "lv"),
                ...openToolItems("transcribe", [songPath], "lv"),
                { id: "lv-visualizer", label: "Make the whole video in Visualizer", tip: "Open Visualizer with this song and these lyrics", onSelect: () => makeInVisualizer(false) },
                { id: "lv-visualizer-window", label: "Make the whole video in Visualizer (new window)", tip: "Open Visualizer with this song and these lyrics in its own window", onSelect: () => makeInVisualizer(true) },
              ]}
            />
            <Button variant="primary" icon="film" collapsible data-tip="Export a short exact preview or the whole video" onClick={() => open(panelDrawerId("render"))}>
              Export
            </Button>
          </>
        }
        rail={
          <>
            <WorkspaceRail
              ws={ws}
              panels={["song", "lyrics", "visuals", "look"]}
              summaries={{
                song: meta.title || basename(songPath),
                lyrics: rowsCount > 0 ? `${rowsCount} lines` : "No lyrics yet",
                visuals: designLabel(prefs.look),
                look: textSummary(prefs.look),
              }}
            />
            {/* Opened by the Export button; its drawer stays mounted. */}
            <span hidden>
              <WorkspacePanel ws={ws} panel="render" />
            </span>
          </>
        }
        stage={
          <div className={styles.stage}>
            {designerOpen ? (
              <DesignerStage songPath={songPath} history={design} />
            ) : (
              <div className={styles.previewBox}>
                <PartFrame part={ws.previewPart} chrome="overlay">
                  <PreviewStage />
                </PartFrame>
              </div>
            )}
            <div className={styles.playerBar} hidden={designerOpen}>
              {media.status === "ready" && media.source ? (
                <MediaPlayer
                  ref={(h) => {
                    playerHandle.current = h;
                  }}
                  source={media.source}
                  kind="audio"
                  compact
                  path={songPath}
                  onTime={(ms) => st().setPlayheadMs(ms)}
                  onPlayingChange={(p) => st().setPlaying(p)}
                  keyboard={!tapping}
                  {...(waveform ? { waveform } : {})}
                />
              ) : media.status === "error" ? (
                <Banner tone="danger" title={media.error?.message ?? "Couldn't open this song"}>
                  {media.error?.hint}
                </Banner>
              ) : (
                <div className={styles.hint}>Opening the song…</div>
              )}
            </div>
            {durationMs > 0 && !designerOpen && (
              <Timeline
                durationMs={durationMs}
                playheadMs={playheadMs}
                onSeek={(ms) => st().seek(ms)}
                markers={markers}
                zoomable
                {...(waveform ? { waveform } : {})}
              />
            )}
          </div>
        }
        side={
          Lines ? (
            <PartFrame part={ws.panelPart} instance="lines" params={{ panel: "lines" }} chrome="overlay">
              <Lines />
            </PartFrame>
          ) : null
        }
      />
      <ConfirmDialog
        open={pendingSong !== null}
        title="Discard your lyric edits?"
        body="The lines you edited by hand will be replaced."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={() => st().resolvePendingSong(true)}
        onCancel={() => st().resolvePendingSong(false)}
      />
    </>
  );
}
