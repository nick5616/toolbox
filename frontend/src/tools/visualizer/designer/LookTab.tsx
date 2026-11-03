/** Look (SPEC.md §8.3): palette, the main sliders, the visual mix, motifs and (Visualizer only) the text. */
import { useEffect, useState } from "react";
import { Section, SegmentedControl, Slider, Switch, TextField, cx } from "@/components";
import { TextStyleEditor } from "@/components/viz/TextStyleEditor";
import { VisualizerService } from "@/lib/api";
import { PALETTES } from "@/viz/palette";
import type { PaletteMode, SignalId, TextStyle } from "@/viz/types";
import { MIX_GROUPS } from "@/viz/types";
import {
  getGlow,
  getGrain,
  getIntensity,
  paletteLimits,
  setGlow,
  setGrain,
  setIntensity,
  setMix,
  setPaletteMode,
  setReactivity,
  setSpeed,
  setText,
  togglePalette,
} from "./model";
import type { TabProps } from "./ReactionsTab";
import { SignalSelect } from "./controls";
import styles from "./designer.module.css";

const MODES: Array<{ value: PaletteMode; label: string }> = [
  { value: "fixed", label: "One" },
  { value: "journey", label: "Journey" },
  { value: "mood", label: "Mood" },
  { value: "chords", label: "Chords" },
  { value: "sections", label: "Sections" },
];

const MODE_HINT: Record<PaletteMode, string> = {
  fixed: "One palette for the whole song.",
  journey: "Travels through 2 to 5 palettes as the song plays.",
  mood: "Colours follow the feeling of the words.",
  chords: "The colour turns with the chords.",
  sections: "Each kind of section gets the next palette.",
};

const MIX_LABEL: Record<string, string> = { drums: "Drums", bass: "Bass", vocals: "Vocals", other: "Other instruments", words: "Words", mood: "Mood" };

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Knob({ label, value, min, max, step, onChange, format = pct }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; format?: (v: number) => string }) {
  return (
    <div className={styles.param}>
      <span className={styles.paramLabel}>{label}</span>
      <Slider aria-label={label} min={min} max={max} step={step} value={value} onChange={onChange} format={format} />
    </div>
  );
}

function TextSection({ show, onChange }: TabProps) {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let off = false;
    VisualizerService.Fonts()
      .then((f) => !off && setFonts(f ?? []))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);
  const t = show.text;
  if (!t) {
    return (
      <Section label="Words on screen">
        <p className={styles.hint}>No words are drawn. Turn them on to show the lyrics or captions in the video.</p>
        <Switch label="Show the words" checked={false} onChange={() => onChange(setText(show, {}))} />
      </Section>
    );
  }
  const patch = (p: Partial<TextStyle>) => onChange(setText(show, p));
  return (
    <Section label="Words on screen" action={<Switch aria-label="Show the words" checked onChange={() => onChange({ ...show, text: null })} />}>
      <TextStyleEditor value={t} onChange={(next) => onChange({ ...show, text: next })} fonts={fonts} allowMood>
      <div className={styles.subTitle}>React to</div>
      <div className={styles.inline}>
        <SignalSelect label="React to" value={t.react.signal} placeholder="Nothing" onNone={() => patch({ react: { ...t.react, signal: null } })} onChange={(signal: SignalId) => patch({ react: { ...t.react, signal } })} />
      </div>
      {t.react.signal && <Knob label="Reaction amount" min={-2} max={2} step={0.05} value={t.react.amount} onChange={(amount) => patch({ react: { ...t.react, amount } })} format={(v) => v.toFixed(2)} />}

      <div className={styles.subTitle}>Title card</div>
      <Switch label="Show the title and artist first" checked={!!t.titleCard} onChange={(on) => patch({ titleCard: on ? { title: t.titleCard?.title ?? "", artist: t.titleCard?.artist ?? "" } : null })} />
      {t.titleCard && (
        <div className={styles.titleFields}>
          <TextField size="sm" aria-label="Title" placeholder="Title" value={t.titleCard.title} onChange={(e) => patch({ titleCard: { title: e.target.value, artist: t.titleCard?.artist ?? "" } })} />
          <TextField size="sm" aria-label="Artist" placeholder="Artist" value={t.titleCard.artist} onChange={(e) => patch({ titleCard: { title: t.titleCard?.title ?? "", artist: e.target.value } })} />
        </div>
      )}
      </TextStyleEditor>
    </Section>
  );
}

export interface LookTabProps extends TabProps {
  /** Show the text section (the Visualizer); false when the host draws the words. */
  engineText: boolean;
}

export function LookTab({ show, onChange, engineText }: LookTabProps) {
  const lim = paletteLimits(show.palette.mode);
  const picks = show.palette.mode === "mood" || show.palette.mode === "chords" ? false : true;
  return (
    <div className={styles.tabBody}>
      <Section label="Colours">
        <SegmentedControl size="sm" aria-label="Palette mode" fullWidth value={show.palette.mode} onChange={(m) => onChange(setPaletteMode(show, m))} options={MODES} />
        <p className={styles.hint}>{MODE_HINT[show.palette.mode]}</p>
        {picks && (
          <div className={styles.swatches} role="group" aria-label="Palettes">
            {PALETTES.map((p) => {
              const idx = show.palette.ids.indexOf(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-label={p.name}
                  aria-pressed={idx >= 0}
                  title={p.name}
                  className={cx(styles.swatch, idx >= 0 && styles.swatchOn)}
                  style={{ background: `linear-gradient(135deg, ${p.colors[0]} 0 33%, ${p.colors[1]} 33% 66%, ${p.colors[2]} 66% 100%)` }}
                  onClick={() => onChange(togglePalette(show, p.id))}
                >
                  {lim.max > 1 && idx >= 0 && <span className={styles.swatchNo}>{idx + 1}</span>}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section label="Feel">
        <Knob label="Reactivity" min={0} max={2} step={0.05} value={show.reactivity} onChange={(v) => onChange(setReactivity(show, v))} format={pct} />
        <Knob label="Speed" min={0.25} max={2} step={0.05} value={show.speed} onChange={(v) => onChange(setSpeed(show, v))} format={(v) => `×${v.toFixed(2)}`} />
        <Knob label="Intensity" min={0.5} max={1.8} step={0.05} value={getIntensity(show)} onChange={(v) => onChange(setIntensity(show, v))} format={(v) => `×${v.toFixed(2)}`} />
        <Knob label="Glow" min={0} max={2} step={0.05} value={getGlow(show)} onChange={(v) => onChange(setGlow(show, v))} format={pct} />
        <Knob label="Grain" min={0} max={1} step={0.01} value={getGrain(show)} onChange={(v) => onChange(setGrain(show, v))} format={pct} />
      </Section>

      <Section label="Visual mix">
        {MIX_GROUPS.map((g) => (
          <Knob key={g} label={MIX_LABEL[g] ?? g} min={0} max={2} step={0.05} value={show.mix[g]} onChange={(v) => onChange(setMix(show, g, v))} format={pct} />
        ))}
        <Switch label="Pictures for what the words describe" checked={show.motifs} onChange={(motifs) => onChange({ ...show, motifs })} />
      </Section>

      {engineText && <TextSection show={show} onChange={onChange} />}
    </div>
  );
}
