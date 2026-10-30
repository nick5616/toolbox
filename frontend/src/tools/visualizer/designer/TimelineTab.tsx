/** Timeline (SPEC.md §8.3, §6.9): the director in Auto or Manual, with one editable row per section. */
import { useMemo } from "react";
import { Button, SegmentedControl, Select, Stepper, cx } from "@/components";
import { formatMs } from "@/components/media";
import type { Analysis } from "@/viz/analysis";
import { autoTimeline } from "@/viz/director";
import { PALETTES } from "@/viz/palette";
import type { PaletteId, Show, TimelineEntry, Transition } from "@/viz/types";
import { patchEntry, resetTimeline, setTimelineMode, TRANSITION_KINDS } from "./model";
import type { TabProps } from "./ReactionsTab";
import styles from "./designer.module.css";

/**
 * One manual entry per section, copied from what auto does, so entry i is
 * section i and clicking a section on the Song Map picks its entry.
 */
export function entriesPerSection(analysis: Analysis, show: Show): TimelineEntry[] {
  const auto = autoTimeline(analysis, show);
  const sections = analysis.audio.sections.length > 0 ? analysis.audio.sections : [{ startMs: 0, endMs: analysis.durationMs }];
  return sections.map((s, i) => {
    const start = i === 0 ? 0 : s.startMs;
    const cover = auto.find((e) => start >= e.startMs && start < e.endMs) ?? auto[auto.length - 1];
    const startsHere = !!cover && Math.abs(cover.startMs - start) < 1500;
    const transition: Transition = i === 0 ? { kind: "cut", ms: 0 } : startsHere && cover ? cover.transition : { kind: "cut", ms: 0 };
    return { startMs: start, endMs: s.endMs, sceneId: cover?.sceneId ?? show.scenes[0]?.id ?? "main", transition };
  });
}

export interface TimelineTabProps extends TabProps {
  analysis: Analysis;
  /** The section picked on the Song Map or in the list. */
  selected: number;
  onSelect(index: number): void;
  /** Plays from just before a section so its transition can be seen. */
  onPreviewTransition?(startMs: number): void;
}

export function TimelineTab({ show, onChange, analysis, selected, onSelect, onPreviewTransition }: TimelineTabProps) {
  const manual = show.timeline.mode === "manual";
  const auto = useMemo(() => (manual ? [] : autoTimeline(analysis, show)), [analysis, show, manual]);
  const entries = show.timeline.entries;
  const sections = analysis.audio.sections;

  const switchMode = (mode: "auto" | "manual") => {
    if (mode === "manual" && entries.length === 0) onChange({ ...show, timeline: { mode: "manual", entries: entriesPerSection(analysis, show) } });
    else onChange(setTimelineMode(show, mode, []));
  };

  const sel = manual ? entries[selected] : undefined;

  return (
    <div className={styles.tabBody}>
      <div className={styles.paramHead}>
        <span className={styles.paramLabel}>Director</span>
        <SegmentedControl
          size="sm"
          aria-label="Director"
          value={show.timeline.mode}
          onChange={switchMode}
          options={[
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual" },
          ]}
        />
      </div>
      <p className={styles.hint}>
        {manual ? "Pick a section here or on the Song Map, then choose its scene, colours and the way it arrives." : "Auto picks a scene for every section of the song. Switch to Manual to take over."}
      </p>

      <ol className={styles.sectionList} aria-label="Sections">
        {(manual ? entries : auto).map((e, i) => {
          const sec = sections[i];
          const scene = show.scenes.find((s) => s.id === e.sceneId);
          return (
            <li key={`${e.startMs}-${i}`}>
              <button type="button" className={cx(styles.sectionItem, manual && selected === i && styles.layerSelected)} aria-current={manual && selected === i ? "true" : undefined} onClick={() => onSelect(i)}>
                <span className={styles.sectionName}>{manual ? (sec ? `${sec.label[0]!.toUpperCase()}${sec.label.slice(1)} ${sec.group}` : `Part ${i + 1}`) : `${formatMs(e.startMs)} · ${scene?.name ?? e.sceneId}`}</span>
                <span className={styles.sectionMeta}>
                  {formatMs(e.startMs)} · {scene?.name ?? e.sceneId} · {e.transition.kind}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {sel && (
        <div className={styles.layerParams} role="group" aria-label="Section settings">
          <label className={styles.inline}>
            <span className={styles.paramLabel}>Scene</span>
            <Select size="sm" aria-label="Scene" value={sel.sceneId} onChange={(sceneId) => onChange(patchEntry(show, selected, { sceneId }))} options={show.scenes.map((s) => ({ value: s.id, label: s.name || s.id }))} />
          </label>
          <label className={styles.inline}>
            <span className={styles.paramLabel}>Colours</span>
            <Select
              size="sm"
              aria-label="Palette"
              value={sel.paletteId ?? ""}
              onChange={(v) => onChange(patchEntry(show, selected, { paletteId: v === "" ? null : (v as PaletteId) }))}
              options={[{ value: "", label: "The design's own" }, ...PALETTES.map((p) => ({ value: p.id as string, label: p.name }))]}
            />
          </label>
          <label className={styles.inline}>
            <span className={styles.paramLabel}>Arrives with</span>
            <Select size="sm" aria-label="Transition" value={sel.transition.kind} onChange={(kind) => onChange(patchEntry(show, selected, { transition: { kind, ms: kind === "cut" ? 0 : sel.transition.ms || 800 } }))} options={TRANSITION_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))} />
          </label>
          {sel.transition.kind !== "cut" && (
            <label className={styles.inline}>
              <span className={styles.paramLabel}>Length</span>
              <Stepper aria-label="Transition length" unit="ms" min={50} max={8000} step={50} value={sel.transition.ms} onChange={(ms) => onChange(patchEntry(show, selected, { transition: { kind: sel.transition.kind, ms } }))} />
            </label>
          )}
          {onPreviewTransition && (
            <Button size="sm" variant="secondary" icon="play" onClick={() => onPreviewTransition(Math.max(0, sel.startMs - 1500))}>
              Play the transition
            </Button>
          )}
        </div>
      )}

      {manual && (
        <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={() => onChange(resetTimeline(show))}>
          Reset to auto
        </Button>
      )}
    </div>
  );
}
