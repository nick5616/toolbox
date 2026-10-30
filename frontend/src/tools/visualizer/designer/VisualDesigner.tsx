/**
 * The embeddable designer (SPEC.md §8.3, §9.4): preview, Why, Song Map and the
 * five tabs. The Visualizer's Design step hosts it with `text: "engine"`;
 * Lyric Video and Subtitles host it with their own words overlay. The host owns
 * the design and its undo (`useShowHistory`); every edit goes through `onChange`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Icon, cx } from "@/components";
import type { MediaPlayerHandle } from "@/components/media";
import { useShortcut } from "@/lib/shortcuts";
import type { Analysis } from "@/viz/analysis";
import { timelineFor } from "@/viz/director";
import { Signals } from "@/viz/signals";
import type { Show } from "@/viz/types";
import { validateShow } from "@/viz/validate";
import { SongMap } from "../SongMap";
import { useVisualizer } from "../store";
import { DesignerContext, useThrottled, type DesignerContextValue } from "./context";
import { LayersTab } from "./LayersTab";
import { LookTab } from "./LookTab";
import { withoutText } from "./model";
import { PresetsTab } from "./PresetsTab";
import { Preview, type DesignerText } from "./Preview";
import { ReactionsTab } from "./ReactionsTab";
import { TimelineTab } from "./TimelineTab";
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
}

const ALL_TABS: Array<{ id: DesignerTab; label: string; icon: string }> = [
  { id: "presets", label: "Presets", icon: "sparkles" },
  { id: "look", label: "Look", icon: "palette" },
  { id: "reactions", label: "Reactions", icon: "activity" },
  { id: "layers", label: "Layers", icon: "layers" },
  { id: "timeline", label: "Timeline", icon: "map" },
];

export function VisualDesigner({ inputPath, analysis, show, onChange, aspect, mode, player, text, tabs, onSavePreset }: VisualDesignerProps) {
  const engineText = text === "engine";
  const visible = useMemo(() => ALL_TABS.filter((t) => !tabs || tabs.includes(t.id)), [tabs]);
  const [tab, setTab] = useState<DesignerTab>(visible[0]?.id ?? "presets");
  const [playheadMs, setPlayheadMs] = useState(0);
  const [section, setSection] = useState(0);
  const ownPlayer = useRef<MediaPlayerHandle>(null);
  const toggleFs = useRef<(() => void) | null>(null);
  const selection = useVisualizer((s) => s.selection);
  const setSelection = useVisualizer((s) => s.setSelection);

  // A host that draws its own words never gets text in the design.
  const emit = useCallback((next: Show) => onChange(engineText ? next : withoutText(next)), [onChange, engineText]);

  const signals = useMemo(() => new Signals(analysis), [analysis]);
  const liveMs = useThrottled(playheadMs, 250);
  const ctx = useMemo<DesignerContextValue>(() => ({ analysis, signals, liveMs }), [analysis, signals, liveMs]);

  // The host's player has no time callback: follow it.
  useEffect(() => {
    if (!player) return;
    let last = -1;
    const t = setInterval(() => {
      const ms = player.currentMs();
      if (ms !== last) {
        last = ms;
        setPlayheadMs(ms);
      }
    }, 33);
    return () => clearInterval(t);
  }, [player]);

  const seek = useCallback(
    (ms: number) => {
      const p = player ?? ownPlayer.current;
      p?.seek(ms);
      setPlayheadMs(ms);
    },
    [player],
  );

  useEffect(() => {
    useVisualizer.getState().setPlayheadMs(liveMs);
  }, [liveMs]);

  useShortcut("f", () => toggleFs.current?.());

  const problem = useMemo(() => {
    const v = validateShow(show);
    return v.ok ? null : v.problem;
  }, [show]);

  const timeline = useMemo(() => timelineFor(analysis, show), [analysis, show]);
  const manual = show.timeline.mode === "manual";
  const editSections = tab === "timeline" && manual;

  const body = (() => {
    switch (tab) {
      case "presets":
        return <PresetsTab show={show} onChange={emit} analysis={analysis} mode={mode} aspect={aspect} playheadMs={liveMs} engineText={engineText} onSavePreset={onSavePreset} />;
      case "look":
        return <LookTab show={show} onChange={emit} engineText={engineText} />;
      case "reactions":
        return <ReactionsTab show={show} onChange={emit} />;
      case "layers":
        return <LayersTab show={show} onChange={emit} />;
      case "timeline":
        return (
          <TimelineTab
            show={show}
            onChange={emit}
            analysis={analysis}
            selected={section}
            onSelect={(i) => {
              setSection(i);
              const s = analysis.audio.sections[i];
              if (s) seek(s.startMs);
            }}
            onPreviewTransition={(ms) => {
              seek(ms);
              (player ?? ownPlayer.current)?.play();
            }}
          />
        );
    }
  })();

  return (
    <DesignerContext.Provider value={ctx}>
      <div className={styles.designer}>
        <div className={styles.left}>
          <Preview
            inputPath={inputPath}
            analysis={analysis}
            show={show}
            aspect={aspect}
            mode={mode}
            hostPlayer={player}
            ownPlayer={ownPlayer}
            text={text}
            timeMs={playheadMs}
            onTime={setPlayheadMs}
            fsRef={toggleFs}
          />
          <WhyPanel show={show} />
          <SongMap
            analysis={analysis}
            timeline={timeline}
            playheadMs={playheadMs}
            onSeek={seek}
            selection={selection}
            onSelect={setSelection}
            onSectionClick={editSections ? (i) => setSection(i) : undefined}
            className={styles.songMap}
          />
        </div>
        <div className={styles.right}>
          <div className={styles.tabs} role="tablist" aria-label="Designer">
            {visible.map((t) => (
              <button key={t.id} type="button" role="tab" id={`vd-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="vd-panel" tabIndex={tab === t.id ? 0 : -1} className={cx(styles.tab, tab === t.id && styles.tabOn)} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={14} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          {problem && (
            <Banner tone="warn" title="This design has a problem">
              {problem}
            </Banner>
          )}
          <div id="vd-panel" role="tabpanel" aria-labelledby={`vd-tab-${tab}`} className={styles.panel}>
            {body}
          </div>
        </div>
      </div>
    </DesignerContext.Provider>
  );
}
