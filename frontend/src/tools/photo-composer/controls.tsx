import { useEffect, useState, type ReactNode } from "react";
import { ColorSwatchPicker, Select, Slider, TextField } from "@/components";
import type { ComposerLook } from "@/lib/api";
import { LOOK_PRESETS } from "@/composer/looks";
import styles from "./controls.module.css";

/** A labelled row of the properties panels. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

export function Group({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

/** A number input that lets you type freely and commits valid values as you go. */
export function NumberField({ label, value, onChange, min, max, step = 1, unit }: NumberFieldProps) {
  const shown = String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  return (
    <TextField
      size="sm"
      type="number"
      aria-label={label}
      value={text}
      step={step}
      min={min}
      max={max}
      trailing={unit ? <span className={styles.unit}>{unit}</span> : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(shown);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() === "" || !Number.isFinite(n)) return;
        const lo = min ?? -Infinity;
        const hi = max ?? Infinity;
        onChange(Math.min(hi, Math.max(lo, n)));
      }}
    />
  );
}

const PRESET_LABELS: Record<string, string> = {
  none: "None",
  vivid: "Vivid",
  warm: "Warm",
  cool: "Cool",
  mono: "Mono",
  fade: "Fade",
  noir: "Noir",
};

const PRESET_OPTIONS = LOOK_PRESETS.map((p) => ({ value: p, label: PRESET_LABELS[p] ?? p }));

/** Look preset plus the four sliders (layers and the background). */
export function LookControls({ look, onChange }: { look: ComposerLook; onChange: (l: ComposerLook) => void }) {
  const set = (patch: Partial<ComposerLook>) => onChange({ ...look, ...patch });
  const pct = (v: number) => `${Math.round(v * 100)}`;
  return (
    <>
      <Row label="Look">
        <Select
          size="sm"
          aria-label="Look preset"
          value={look.preset as (typeof LOOK_PRESETS)[number]}
          options={PRESET_OPTIONS}
          onChange={(preset) => set({ preset })}
        />
      </Row>
      <Row label="Brightness">
        <Slider aria-label="Brightness" min={-1} max={1} step={0.01} value={look.brightness} format={pct} onChange={(v) => set({ brightness: v })} />
      </Row>
      <Row label="Contrast">
        <Slider aria-label="Contrast" min={-1} max={1} step={0.01} value={look.contrast} format={pct} onChange={(v) => set({ contrast: v })} />
      </Row>
      <Row label="Saturation">
        <Slider aria-label="Saturation" min={-1} max={1} step={0.01} value={look.saturation} format={pct} onChange={(v) => set({ saturation: v })} />
      </Row>
      <Row label="Warmth">
        <Slider aria-label="Warmth" min={-1} max={1} step={0.01} value={look.warmth} format={pct} onChange={(v) => set({ warmth: v })} />
      </Row>
    </>
  );
}

export function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <ColorSwatchPicker aria-label={label} value={value} onChange={onChange} />;
}
