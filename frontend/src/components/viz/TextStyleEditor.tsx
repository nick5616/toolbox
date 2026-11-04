/**
 * The controls for a TextStyle (Visualizer "Words on screen", Edit Studio
 * captions). Controlled; renders a fragment so the host's section lays it out.
 */
import type { ReactNode } from "react";
import { ColorSwatchPicker, SegmentedControl, Select, Slider, Switch, TextField, cx } from "@/components";
import type { TextStyle } from "@/viz/types";
import styles from "./TextStyleEditor.module.css";

export const TEXT_PRESET_CARDS: ReadonlyArray<{ id: TextStyle["preset"]; label: string; hint: string }> = [
  { id: "karaoke", label: "Karaoke", hint: "Words fill as they are sung" },
  { id: "pop", label: "Pop", hint: "Words pop in with a bounce" },
  { id: "rise", label: "Rise", hint: "Lines float up and fade in" },
  { id: "typewriter", label: "Typewriter", hint: "Letters appear one by one" },
  { id: "fade", label: "Fade", hint: "Soft fades, nothing else" },
  { id: "wave", label: "Wave", hint: "Words bob while sung" },
  { id: "subtitle", label: "Subtitle", hint: "Plain readable captions" },
  { id: "subtitle-boxed", label: "Boxed", hint: "Captions on a dark box" },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

const KNOB_TIP: Record<string, string> = {
  Size: "Text height as a percentage of the picture's short side",
  Outline: "Thickness of the dark edge that keeps text readable on busy pictures",
  "Text glow": "A soft halo around the words",
  "Emphasis size": "How much bigger emphasised words are drawn; ×1 is the same size",
  "Emphasis glow": "How strongly emphasised words glow",
};

function Knob({ label, value, min, max, step, onChange, format = pct }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; format?: (v: number) => string }) {
  return (
    <div className={styles.param}>
      <span className={styles.paramLabel} data-tip={KNOB_TIP[label] ?? label}>{label}</span>
      <Slider aria-label={label} min={min} max={max} step={step} value={value} onChange={onChange} format={format} />
    </div>
  );
}

export interface TextStyleEditorProps {
  /** Largest size in % of the short side (captions 12; Edit Studio text clips 30). */
  maxSize?: number;
  value: TextStyle;
  onChange(next: TextStyle): void;
  /** Font names to offer; empty falls back to a text field. */
  fonts: string[];
  /** Offer "From the mood" for the highlight and emphasis colours (needs a mood analysis). */
  allowMood?: boolean;
  /** Extra controls drawn after the emphasis group (the Visualizer's React to and Title card). */
  children?: ReactNode;
}

export function TextStyleEditor({ value: t, onChange, fonts, allowMood = true, maxSize = 12, children }: TextStyleEditorProps) {
  const patch = (p: Partial<TextStyle>) => onChange({ ...t, ...p });
  const fontList = fonts.includes(t.font) || fonts.length === 0 ? fonts : [t.font, ...fonts];
  return (
    <>
      <div className={styles.cards} role="radiogroup" aria-label="Text style" data-tip="How the words appear and move on screen">
        {TEXT_PRESET_CARDS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={t.preset === p.id}
            data-tip={`${p.label}: ${p.hint}`}
            className={cx(styles.textCard, t.preset === p.id && styles.selected)}
            onClick={() => patch({ preset: p.id, position: p.id === "subtitle" || p.id === "subtitle-boxed" ? "lower" : t.position })}
          >
            <strong>{p.label}</strong>
            <span>{p.hint}</span>
          </button>
        ))}
      </div>
      <label className={styles.inline}>
        <span className={styles.paramLabel} data-tip="The typeface for the words">Font</span>
        {fontList.length > 0 ? (
          <Select size="sm" aria-label="Font" data-tip="Choose a typeface installed on this computer" value={t.font} onChange={(font) => patch({ font })} options={fontList.map((f) => ({ value: f, label: f }))} />
        ) : (
          <TextField size="sm" aria-label="Font" data-tip="The name of an installed typeface" value={t.font} onChange={(e) => patch({ font: e.target.value })} />
        )}
      </label>
      <label className={styles.inline}>
        <span className={styles.paramLabel} data-tip="How heavy the letters are">Weight</span>
        <SegmentedControl size="sm" aria-label="Weight" value={String(t.weight)} onChange={(w) => patch({ weight: Number(w) as TextStyle["weight"] })} options={[{ value: "400", label: "Regular", tip: "Normal letter weight" }, { value: "700", label: "Bold", tip: "Heavier letters that read better on busy pictures" }, { value: "900", label: "Black", tip: "The heaviest weight, for a strong look" }]} />
      </label>
      <Knob label="Size" min={3} max={maxSize} step={0.5} value={t.size} onChange={(size) => patch({ size })} format={(v) => `${v}%`} />
      <div className={styles.param}>
        <span className={styles.paramLabel} data-tip="Colour of the words; white, black or any #rrggbb">Text colour</span>
        <ColorSwatchPicker aria-label="Text colour" value={t.color} onChange={(color) => patch({ color })} />
      </div>
      <div className={styles.param}>
        <span className={styles.paramLabel} data-tip="Colour of the word being sung or spoken">Highlight</span>
        {allowMood && (
          <SegmentedControl size="sm" aria-label="Highlight" value={t.highlight === "mood" ? "mood" : "colour"} onChange={(v) => patch({ highlight: v === "mood" ? "mood" : t.highlight === "mood" ? "#ffd166" : t.highlight })} options={[{ value: "mood", label: "From the mood", tip: "Let the feeling of the words choose the colour" }, { value: "colour", label: "Colour", tip: "Use one colour you pick" }]} />
        )}
        {(t.highlight !== "mood" || !allowMood) && <ColorSwatchPicker aria-label="Highlight colour" value={t.highlight === "mood" ? "#ffd166" : t.highlight} onChange={(highlight) => patch({ highlight })} />}
      </div>
      <label className={styles.inline}>
        <span className={styles.paramLabel} data-tip="Where on the picture the words sit">Position</span>
        <SegmentedControl size="sm" aria-label="Position" value={t.position} onChange={(position) => patch({ position })} options={[{ value: "upper", label: "Top", tip: "Near the top of the picture" }, { value: "center", label: "Middle", tip: "In the middle of the picture" }, { value: "lower", label: "Bottom", tip: "Near the bottom, like subtitles" }]} />
      </label>
      <Switch tip="Also show the upcoming line, dimmed, so viewers can read ahead" label="Show the next line" checked={t.showNext} onChange={(showNext) => patch({ showNext })} />
      <Switch tip="Draw all the words in capital letters" label="Capital letters" checked={t.uppercase} onChange={(uppercase) => patch({ uppercase })} />
      <Knob label="Outline" min={0} max={0.15} step={0.005} value={t.outline} onChange={(outline) => patch({ outline })} />
      <Knob label="Text glow" min={0} max={1} step={0.05} value={t.glow} onChange={(glow) => patch({ glow })} />

      <div className={styles.subTitle} data-tip="Words picked out as important get extra size, glow and colour">Emphasised words</div>
      <Knob label="Emphasis size" min={1} max={2} step={0.05} value={t.emphasis.scale} onChange={(scale) => patch({ emphasis: { ...t.emphasis, scale } })} format={(v) => `×${v.toFixed(2)}`} />
      <Knob label="Emphasis glow" min={0} max={2} step={0.05} value={t.emphasis.glow} onChange={(glow) => patch({ emphasis: { ...t.emphasis, glow } })} />
      <label className={styles.inline}>
        <span className={styles.paramLabel} data-tip="Colour of emphasised words">Emphasis colour</span>
        <SegmentedControl size="sm" aria-label="Emphasis colour" value={t.emphasis.color} onChange={(color) => patch({ emphasis: { ...t.emphasis, color } })} options={allowMood ? [{ value: "highlight", label: "Highlight", tip: "Use the highlight colour" }, { value: "mood", label: "Mood", tip: "Use a colour from the feeling of the words" }] : [{ value: "highlight", label: "Highlight", tip: "Use the highlight colour" }]} />
      </label>
      <Switch tip="Throw small sparks off emphasised words" label="Sparks on emphasised words" checked={t.emphasis.sparks} onChange={(sparks) => patch({ emphasis: { ...t.emphasis, sparks } })} />
      {children}
    </>
  );
}
