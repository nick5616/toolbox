/** Look (SPEC.md §8.3): palette, the main sliders, the visual mix, motifs and (Visualizer only) the text. */
import { useEffect, useState } from "react";
import { ColorSwatchPicker, Section, SegmentedControl, Select, Slider, Switch, TextField, cx } from "@/components";
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
  TEXT_PRESETS,
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
  const fontList = fonts.includes(t.font) || fonts.length === 0 ? fonts : [t.font, ...fonts];
  return (
    <Section label="Words on screen" action={<Switch aria-label="Show the words" checked onChange={() => onChange({ ...show, text: null })} />}>
      <div className={styles.cards} role="radiogroup" aria-label="Text style">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={t.preset === p.id}
            className={cx(styles.textCard, t.preset === p.id && styles.layerSelected)}
            onClick={() => patch({ preset: p.id, position: p.id === "subtitle" || p.id === "subtitle-boxed" ? "lower" : t.position })}
          >
            <strong>{p.label}</strong>
            <span>{p.hint}</span>
          </button>
        ))}
      </div>
      <label className={styles.inline}>
        <span className={styles.paramLabel}>Font</span>
        {fontList.length > 0 ? (
          <Select size="sm" aria-label="Font" value={t.font} onChange={(font) => patch({ font })} options={fontList.map((f) => ({ value: f, label: f }))} />
        ) : (
          <TextField size="sm" aria-label="Font" value={t.font} onChange={(e) => patch({ font: e.target.value })} />
        )}
      </label>
      <label className={styles.inline}>
        <span className={styles.paramLabel}>Weight</span>
        <SegmentedControl size="sm" aria-label="Weight" value={String(t.weight)} onChange={(w) => patch({ weight: Number(w) as TextStyle["weight"] })} options={[{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }, { value: "900", label: "Black" }]} />
      </label>
      <Knob label="Size" min={3} max={12} step={0.5} value={t.size} onChange={(size) => patch({ size })} format={(v) => `${v}%`} />
      <div className={styles.param}>
        <span className={styles.paramLabel}>Text colour</span>
        <ColorSwatchPicker aria-label="Text colour" value={t.color} onChange={(color) => patch({ color })} />
      </div>
      <div className={styles.param}>
        <span className={styles.paramLabel}>Highlight</span>
        <SegmentedControl size="sm" aria-label="Highlight" value={t.highlight === "mood" ? "mood" : "colour"} onChange={(v) => patch({ highlight: v === "mood" ? "mood" : t.highlight === "mood" ? "#ffd166" : t.highlight })} options={[{ value: "mood", label: "From the mood" }, { value: "colour", label: "Colour" }]} />
        {t.highlight !== "mood" && <ColorSwatchPicker aria-label="Highlight colour" value={t.highlight} onChange={(highlight) => patch({ highlight })} />}
      </div>
      <label className={styles.inline}>
        <span className={styles.paramLabel}>Position</span>
        <SegmentedControl size="sm" aria-label="Position" value={t.position} onChange={(position) => patch({ position })} options={[{ value: "upper", label: "Top" }, { value: "center", label: "Middle" }, { value: "lower", label: "Bottom" }]} />
      </label>
      <Switch label="Show the next line" checked={t.showNext} onChange={(showNext) => patch({ showNext })} />
      <Switch label="Capital letters" checked={t.uppercase} onChange={(uppercase) => patch({ uppercase })} />
      <Knob label="Outline" min={0} max={0.15} step={0.005} value={t.outline} onChange={(outline) => patch({ outline })} />
      <Knob label="Text glow" min={0} max={1} step={0.05} value={t.glow} onChange={(glow) => patch({ glow })} />

      <div className={styles.subTitle}>Emphasised words</div>
      <Knob label="Emphasis size" min={1} max={2} step={0.05} value={t.emphasis.scale} onChange={(scale) => patch({ emphasis: { ...t.emphasis, scale } })} format={(v) => `×${v.toFixed(2)}`} />
      <Knob label="Emphasis glow" min={0} max={2} step={0.05} value={t.emphasis.glow} onChange={(glow) => patch({ emphasis: { ...t.emphasis, glow } })} />
      <label className={styles.inline}>
        <span className={styles.paramLabel}>Emphasis colour</span>
        <SegmentedControl size="sm" aria-label="Emphasis colour" value={t.emphasis.color} onChange={(color) => patch({ emphasis: { ...t.emphasis, color } })} options={[{ value: "highlight", label: "Highlight" }, { value: "mood", label: "Mood" }]} />
      </label>
      <Switch label="Sparks on emphasised words" checked={t.emphasis.sparks} onChange={(sparks) => patch({ emphasis: { ...t.emphasis, sparks } })} />

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
