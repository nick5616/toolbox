/**
 * The embeddable designer (SPEC.md §8.3, §9.4; Phase 10 layout): the preview
 * and Song Map get the room; a compact rail beside them holds a few headline
 * reactions and one click-in per section (Presets, Look, Reactions, Layers,
 * Timeline, Why), each with a one-line summary. The Visualizer's Design step
 * hosts it with `text: "engine"` (and its preview can pop out); Lyric Video and
 * Subtitles host it with their own words overlay. The host owns the design and
 * its undo (`useShowHistory`); every edit goes through `onChange`.
 *
 * A shared building block (Phase 11, `blocks/visuals`): it never imports a
 * tool. Hosts that keep the Song Map selection or the playhead in their own
 * store pass them in (`selection`/`onSelect`, `onPlayhead`); hosts with a
 * pop-out preview pass its part id (`previewPart`) and the time the popped-out
 * preview plays (`windowPlayheadMs`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Banner, ClickIn, ClickInHost, Slider } from "@/components";
import type { MediaPlayerHandle } from "@/components/media";
import { SHORT_QUERY, useMediaQuery } from "@/lib/media";
import { useShortcut } from "@/lib/shortcuts";
import { partWindowKey } from "@/lib/windows";
import { PartFrame } from "@/parts/PartFrame";
import { useWindowOpen } from "@/state/windows";
import type { Analysis } from "@/viz/analysis";
import { timelineFor } from "@/viz/director";
import { Signals } from "@/viz/signals";
import type { Show } from "@/viz/types";
import { validateShow } from "@/viz/validate";
import { SongMap, type SongMapLane, type SongMapProps } from "../songmap/SongMap";
import { DesignerContext, type DesignerContextValue } from "./context";
import { LayersTab } from "./LayersTab";
import { LookTab } from "./LookTab";
import { reactionMod, setReactionAmount, withoutText } from "./model";
import { PresetsTab } from "./PresetsTab";
import { createPlayheadStore, followPlayer, usePlayhead, useThrottledPlayhead, type PlayheadStore } from "./playhead";
import { Preview, type DesignerText, type PreviewProps } from "./Preview";
import { ReactionsTab } from "./ReactionsTab";
import { layersSummary, lookSummary, presetSummary, reactionsSummary, timelineSummary } from "./summaries";
import { TimelineTab } from "./TimelineTab";
import { whyFacts } from "./why";
import { WhyPanel } from "./WhyPanel";
import styles from "./designer.module.css";

export type DesignerTab = "presets" | "look" | "reactions" | "layers" | "timeline";

export interface VisualDesignerProps {
  inputPath: string;
  analysis: Analysis; // loaded by the host (useVisualsAnalysis)
  show: Show;
  onChange(show: Show): void; // every edit; the host owns undo (useShowHistory)
  aspect: number; // locked when the host fixes the output shape
  mode: "full" | "overlay";
  player: MediaPlayerHandle | null; // the host's player drives time; null = the designer's own audio player
  text: DesignerText; // engine text (Visualizer) or the host's preview text
  tabs?: DesignerTab[]; // default: all
  onSavePreset?(show: Show): void; // "Save as my preset"
  /** The Song Map selection (the export range); without it the designer keeps its own. */
  selection?: DesignerSelection;
  onSelect?(selection: DesignerSelection): void;
  /** Reports the (throttled) playhead, e.g. into the host's store for a popped-out preview. */
  onPlayhead?(ms: number): void;
  /** A registered part that shows this preview in its own window (the host bridges its store); omit for no pop-out. */
  previewPart?: string;
  /** While `previewPart`'s window is open, the time it plays (it drives the playhead). */
  windowPlayheadMs?: number;
}

export type DesignerSelection = { startMs: number; endMs: number } | null;

const ALL_TABS: Array<{ id: DesignerTab; label: string; icon: string }> = [
  { id: "presets", label: "Presets", icon: "sparkles" },
  { id: "look", label: "Look", icon: "palette" },
  { id: "reactions", label: "Reactions", icon: "activity" },
  { id: "layers", label: "Layers", icon: "layers" },
  { id: "timeline", label: "Timeline", icon: "map" },
];

const TAB_TIP: Record<DesignerTab, string> = {
  presets: "Start from a ready-made look, or one of your saved designs",
  look: "Colours, how strongly it reacts, glow, grain and the words on screen",
  reactions: "Choose which parts of the music move which settings",
  layers: "Build the picture layer by layer, with effects and settings",
  timeline: "Decide which scene plays in each section of the song",
};

/** How many of a design's own reactions the rail shows as sliders. */
export const HEADLINE_CONTROLS = 3;
/** Short windows give the Song Map fewer lanes so the preview keeps its room. */
const SHORT_LANES: SongMapLane[] = ["sections", "drums", "vocals", "chords"];
export const HEADLINE_CONTROLS_SHORT = 2;

export function VisualDesigner(props: VisualDesignerProps) {
  return (
    <ClickInHost className={styles.designer}>
      <Designer {...props} />
    </ClickInHost>
  );
}

function Designer({ inputPath, analysis, show, onChange, aspect, mode, player, text, tabs, onSavePreset, selection: hostSelection, onSelect, onPlayhead, previewPart, windowPlayheadMs }: VisualDesignerProps) {
  const engineText = text === "engine";
  const visible = useMemo(() => ALL_TABS.filter((t) => !tabs || tabs.includes(t.id)), [tabs]);
  const short = useMediaQuery(SHORT_QUERY);
  // The playhead ticks ~30x a second: it lives in a store only the preview and the Song Map read.
  const playhead = useMemo(() => createPlayheadStore(0), []);
  const setPlayheadMs = playhead.set;
  const [section, setSection] = useState(0);
  const ownPlayer = useRef<MediaPlayerHandle>(null);
  const toggleFs = useRef<(() => void) | null>(null);
  const [ownSelection, setOwnSelection] = useState<DesignerSelection>(null);
  const selection = onSelect ? (hostSelection ?? null) : ownSelection;
  const setSelection = onSelect ?? setOwnSelection;

  // While the preview is in its own window, its player drives the playhead (through the host's store).
  const previewOut = useWindowOpen(previewPart ? partWindowKey(previewPart) : "");
  useEffect(() => {
    if (previewPart && previewOut && windowPlayheadMs !== undefined) setPlayheadMs(windowPlayheadMs);
  }, [previewPart, previewOut, windowPlayheadMs, setPlayheadMs]);

  // A host that draws its own words never gets text in the design.
  const emit = useCallback((next: Show) => onChange(engineText ? next : withoutText(next)), [onChange, engineText]);

  const signals = useMemo(() => new Signals(analysis), [analysis]);
  const liveMs = useThrottledPlayhead(playhead, 250);
  const ctx = useMemo<DesignerContextValue>(() => ({ analysis, signals, liveMs }), [analysis, signals, liveMs]);

  // The host's player has no time callback: follow it (fast while it plays, slowly otherwise).
  useEffect(() => {
    if (!player) return;
    return followPlayer(player, playhead);
  }, [player, playhead]);

  const seek = useCallback(
    (ms: number) => {
      const p = player ?? ownPlayer.current;
      p?.seek(ms);
      setPlayheadMs(ms);
    },
    [player, setPlayheadMs],
  );

  useEffect(() => {
    onPlayhead?.(liveMs);
  }, [liveMs, onPlayhead]);

  useShortcut("f", () => toggleFs.current?.());

  const problem = useMemo(() => {
    const v = validateShow(show);
    return v.ok ? null : v.problem;
  }, [show]);

  const timeline = useMemo(() => timelineFor(analysis, show), [analysis, show]);
  const manual = show.timeline.mode === "manual";
  const facts = useMemo(() => whyFacts(show, analysis, signals, liveMs), [show, analysis, signals, liveMs]);

  const previewEl = <LivePreview store={playhead} inputPath={inputPath} analysis={analysis} show={show} aspect={aspect} mode={mode} hostPlayer={player} ownPlayer={ownPlayer} text={text} onTime={setPlayheadMs} fsRef={toggleFs} />;

  // Each tab body is memoised: a playhead tick or another tab's edit never rebuilds it (only the open one mounts).
  const onTimelineSelect = useCallback(
    (i: number) => {
      setSection(i);
      const s = analysis.audio.sections[i];
      if (s) seek(s.startMs);
    },
    [analysis, seek],
  );
  const onPreviewTransition = useCallback(
    (ms: number) => {
      seek(ms);
      (player ?? ownPlayer.current)?.play();
    },
    [seek, player],
  );
  const presetsBody = useMemo(
    () => <PresetsTab show={show} onChange={emit} analysis={analysis} mode={mode} aspect={aspect} playheadMs={liveMs} engineText={engineText} onSavePreset={onSavePreset} />,
    [show, emit, analysis, mode, aspect, liveMs, engineText, onSavePreset],
  );
  const lookBody = useMemo(() => <LookTab show={show} onChange={emit} engineText={engineText} />, [show, emit, engineText]);
  const reactionsBody = useMemo(() => <ReactionsTab show={show} onChange={emit} />, [show, emit]);
  const layersBody = useMemo(() => <LayersTab show={show} onChange={emit} />, [show, emit]);
  const timelineBody = useMemo(
    () => <TimelineTab show={show} onChange={emit} analysis={analysis} selected={section} onSelect={onTimelineSelect} onPreviewTransition={onPreviewTransition} />,
    [show, emit, analysis, section, onTimelineSelect, onPreviewTransition],
  );
  const bodies: Record<DesignerTab, ReactNode> = { presets: presetsBody, look: lookBody, reactions: reactionsBody, layers: layersBody, timeline: timelineBody };
  const summary = useMemo<Record<DesignerTab, string>>(
    () => ({
      presets: presetSummary(show),
      look: lookSummary(show),
      reactions: reactionsSummary(show),
      layers: layersSummary(show),
      timeline: timelineSummary(show, analysis),
    }),
    [show, analysis],
  );

  const headline = show.controls.slice(0, short ? HEADLINE_CONTROLS_SHORT : HEADLINE_CONTROLS);
  const showReactions = !tabs || tabs.includes("reactions");

  return (
    <DesignerContext.Provider value={ctx}>
      <div className={styles.left}>
        {problem && (
          <Banner tone="warn" title="This design has a problem">
            {problem}
          </Banner>
        )}
        <div className={styles.previewSlot}>
          {previewPart ? (
            <PartFrame part={previewPart} chrome="overlay">
              {previewEl}
            </PartFrame>
          ) : (
            previewEl
          )}
        </div>
        <LiveSongMap
          store={playhead}
          analysis={analysis}
          timeline={timeline}
          onSeek={seek}
          selection={selection}
          onSelect={setSelection}
          onSectionClick={manual ? setSection : undefined}
          lanes={short ? SHORT_LANES : undefined}
          className={styles.songMap}
        />
      </div>
      <nav className={styles.rail} aria-label="Designer">
        {showReactions && headline.length > 0 && (
          <div className={styles.headline} role="group" aria-label="Main reactions">
            {headline.map((slot) => {
              const i = show.controls.indexOf(slot);
              const mod = reactionMod(show, slot);
              return (
                <label key={slot.target} className={styles.headlineRow} data-tip={`How strongly ${slot.label} follows the music`}>
                  <span className={styles.headlineLabel}>{slot.label}</span>
                  <Slider aria-label={`${slot.label} level`} min={-2} max={2} step={0.05} value={mod?.amount ?? 0} onChange={(v) => emit(setReactionAmount(show, i, v))} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`} />
                </label>
              );
            })}
          </div>
        )}
        {visible.map((t) => (
          <ClickIn key={t.id} className={styles.railRow} id={`vd-${t.id}`} icon={t.icon} title={t.label} summary={summary[t.id]} tip={TAB_TIP[t.id]}>
            {bodies[t.id]}
          </ClickIn>
        ))}
        {facts.length > 0 && (
          <ClickIn className={styles.railRow} id="vd-why" icon="info" title="Why" summary={facts[0]} tip="What is driving the visuals at the playhead right now">
            <WhyPanel show={show} />
          </ClickIn>
        )}
      </nav>
    </DesignerContext.Provider>
  );
}

/** The preview, subscribed to the playhead (with the Song Map, the only part of the designer that follows every tick). */
function LivePreview({ store, ...rest }: Omit<PreviewProps, "timeMs"> & { store: PlayheadStore; fsRef: Parameters<typeof Preview>[0]["fsRef"] }) {
  const timeMs = usePlayhead(store);
  return <Preview {...rest} timeMs={timeMs} />;
}

function LiveSongMap({ store, ...rest }: Omit<SongMapProps, "playheadMs"> & { store: PlayheadStore }) {
  const playheadMs = usePlayhead(store);
  return <SongMap {...rest} playheadMs={playheadMs} />;
}
