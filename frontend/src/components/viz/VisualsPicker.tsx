/**
 * The quick visuals picker for Lyric Video and Subtitles (SPEC.md §9.1):
 * listening progress, live design cards, Intensity and Colours, two switches
 * and a way into the full designer. It never renders text; the tool draws its
 * own words.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Meter } from "@/components/Meter";
import { Slider } from "@/components/Slider";
import { Switch } from "@/components/Switch";
import { cx } from "@/components/cx";
import { SettingsService, VisualizerService, type TimedLine, type VisualsSpec } from "@/lib/api";
import type { Show } from "@/viz/types";
import { PresetThumbs, type ThumbItem } from "./PresetThumbs";
import {
  CUSTOM_ID,
  SWATCH_PALETTES,
  fixedPaletteId,
  parseShow,
  pickerAnalyzeOptions,
  presetItems,
  readMyDesigns,
  selectedIdFor,
  withFixedPalette,
  withPalette,
  withReactivity,
} from "./pickerModel";
import { useVisualsAnalysis } from "./useVisualsAnalysis";
import styles from "./VisualsPicker.module.css";

export interface VisualsPickerProps {
  inputPath: string;
  /** The tool's timed text (lyrics or cues), for word reactions and mood. */
  lines: TimedLine[] | null;
  value: VisualsSpec | null;
  onChange(v: VisualsSpec): void;
  /** overlay = over a video (background layers dropped). */
  mode: "background" | "overlay";
  /** The tool's output aspect (width / height). */
  aspect: number;
  /** The tool's player position, if it has one. */
  playheadMs?: number;
  /** "Open the full designer" (the host switches to its embedded designer). */
  onOpenDesigner?(): void;
  className?: string;
}

export function VisualsPicker({ inputPath, lines, value, onChange, mode, aspect, playheadMs, onOpenDesigner, className }: VisualsPickerProps) {
  const hasLines = (lines?.length ?? 0) > 0;
  const [stems, setStems] = useState(value?.stems ?? false);
  const [useWords, setUseWords] = useState(value?.useWords ?? true);
  const [moodReady, setMoodReady] = useState(false);
  const [moodChecked, setMoodChecked] = useState(false);
  const [mine, setMine] = useState<ThumbItem[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    VisualizerService.MoodReaderReady()
      .then((ok) => alive && setMoodReady(Boolean(ok)))
      .catch(() => undefined)
      .finally(() => alive && setMoodChecked(true));
    SettingsService.ModuleState("visualizer")
      .then((s) => alive && setMine(readMyDesigns(s)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const analyze = useMemo(() => pickerAnalyzeOptions({ stems, useWords: useWords && hasLines, lines, moodReady }), [stems, useWords, hasLines, lines, moodReady]);
  const listening = useVisualsAnalysis(inputPath, { analyze, auto: moodChecked });

  const show = useMemo(() => parseShow(value?.showJson), [value?.showJson]);
  const presets = useMemo(() => presetItems(mode), [mode]);
  const selectedId = useMemo(() => {
    if (!show) return null;
    if (picked && (picked === CUSTOM_ID || mine.some((i) => i.id === picked) || presets.some((i) => i.id === picked))) return picked;
    return selectedIdFor(show, mine, presets);
  }, [show, picked, mine, presets]);

  const items = useMemo(() => {
    const out: ThumbItem[] = [...mine];
    if (show && selectedId === CUSTOM_ID) out.push({ id: CUSTOM_ID, name: "Custom design", description: "Made in the full designer", show, kind: "custom" });
    return [...out, ...presets];
  }, [mine, presets, show, selectedId]);

  /** The unedited show behind the selected card (for "Design's own" colours). */
  const base = useMemo<Show | null>(() => items.find((i) => i.id === selectedId)?.show ?? show, [items, selectedId, show]);

  const emit = useCallback(
    (next: Show, over?: Partial<VisualsSpec>) => {
      onChange({ showJson: JSON.stringify(next), stems, useWords, ...over });
    },
    [onChange, stems, useWords],
  );

  const select = (item: ThumbItem) => {
    setPicked(item.id);
    if (item.id === CUSTOM_ID && show) return;
    emit(item.show);
  };

  const ownPalette = show && base ? JSON.stringify(show.palette) === JSON.stringify(base.palette) : false;
  const fixedId = show ? fixedPaletteId(show) : null;
  const busy = listening.status === "checking" || listening.status === "running";
  const pct = Math.round(listening.progress * 100);

  return (
    <div className={cx(styles.root, className)}>
      {listening.status === "running" && (
        <div className={styles.listening} role="status">
          <div className={styles.listeningText}>
            <span>
              Listening to the song…{pct > 0 ? ` ${pct}%` : ""}
            </span>
            {listening.stage && <span className={styles.stage}>{listening.stage}</span>}
            <Button size="sm" variant="ghost" onClick={listening.cancel}>
              Cancel
            </Button>
          </div>
          <Meter value={listening.progress > 0 ? listening.progress : -1} label="Listening progress" size="sm" />
        </div>
      )}
      {listening.status === "error" && listening.error && (
        <Banner
          tone="danger"
          title={listening.error.message}
          action={
            <Button size="sm" onClick={listening.start}>
              Try again
            </Button>
          }
        >
          {listening.error.hint}
        </Banner>
      )}

      <PresetThumbs
        items={items}
        analysis={listening.analysis}
        timeMs={playheadMs ?? null}
        aspect={aspect}
        mode={mode === "overlay" ? "overlay" : "opaque"}
        selectedId={selectedId}
        onSelect={select}
      />

      <div className={styles.controls}>
        <Field label="Intensity" htmlFor="viz-intensity">
          <Slider id="viz-intensity" aria-label="Intensity" min={0} max={2} step={0.05} value={show?.reactivity ?? 1} disabled={!show} format={(v) => v.toFixed(2)} onChange={(v) => show && emit(withReactivity(show, v))} />
        </Field>
        <Field label="Colours">
          <div className={styles.swatches} role="group" aria-label="Colours">
            <button type="button" className={cx(styles.own, ownPalette && styles.on)} aria-pressed={ownPalette} disabled={!show || !base} onClick={() => show && base && emit(withPalette(show, base.palette))}>
              Design&apos;s own
            </button>
            {SWATCH_PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cx(styles.swatch, fixedId === p.id && styles.on)}
                style={{ background: `linear-gradient(135deg, ${p.colors[0]} 50%, ${p.colors[1]} 50%)` }}
                aria-label={p.name}
                aria-pressed={fixedId === p.id}
                title={p.name}
                disabled={!show}
                onClick={() => show && emit(withFixedPalette(show, p.id))}
              />
            ))}
          </div>
        </Field>
      </div>

      <div className={styles.switches}>
        <Switch
          label="Separate instruments"
          checked={stems}
          disabled={busy}
          onChange={(v) => {
            setStems(v);
            if (show) emit(show, { stems: v });
          }}
        />
        <span className={styles.hint}>Richer reactions; takes about as long as the song.</span>
        {hasLines && (
          <Switch
            label="React to the words"
            checked={useWords}
            onChange={(v) => {
              setUseWords(v);
              if (show) emit(show, { useWords: v });
            }}
          />
        )}
      </div>

      {onOpenDesigner && (
        <div>
          <Button variant="secondary" icon="sliders-horizontal" onClick={onOpenDesigner}>
            Open the full designer
          </Button>
        </div>
      )}
    </div>
  );
}
