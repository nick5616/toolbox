import { useEffect, useState, type ReactNode } from "react";
import { ColorSwatchPicker, Select, Slider, TextField } from "@/components";
import type { ComposerLook } from "@/lib/api";
import { LOOK_PRESETS } from "@/composer/looks";
import styles from "./controls.module.css";

/** A labelled row of the properties panels. */
export function Row({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <div className={styles.row} data-tip={tip}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

export function Group({ title, children, actions, tip }: { title: string; children: ReactNode; actions?: ReactNode; tip?: string }) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHead}>
        <h3 className={styles.groupTitle} data-tip={tip}>
          {title}
        </h3>
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
  /** Tooltip: what the number means. */
  tip?: string;
}

/** A number input that lets you type freely and commits valid values as you go. */
export function NumberField({ label, value, onChange, min, max, step = 1, unit, tip }: NumberFieldProps) {
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
      data-tip={tip}
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

const PRESET_TIPS: Record<string, string> = {
  none: "No colour treatment",
  vivid: "Richer, punchier colours",
  warm: "Golden, warmer tones",
  cool: "Bluer, cooler tones",
  mono: "Black and white",
  fade: "Lifted blacks and soft colour, like faded film",
  noir: "High-contrast black and white",
};

const PRESET_OPTIONS = LOOK_PRESETS.map((p) => ({ value: p, label: PRESET_LABELS[p] ?? p }));

/** Look preset plus the four sliders (layers and the background). */
export function LookControls({ look, onChange }: { look: ComposerLook; onChange: (l: ComposerLook) => void }) {
  const set = (patch: Partial<ComposerLook>) => onChange({ ...look, ...patch });
  const pct = (v: number) => `${Math.round(v * 100)}`;
  return (
    <>
      <Row label="Look" tip={`A ready-made colour treatment: ${(PRESET_TIPS[look.preset] ?? "").toLowerCase()}`}>
        <Select
          size="sm"
          aria-label="Look preset"
          data-tip={`A ready-made colour treatment: ${(PRESET_TIPS[look.preset] ?? "").toLowerCase()}`}
          value={look.preset as (typeof LOOK_PRESETS)[number]}
          options={PRESET_OPTIONS}
          onChange={(preset) => set({ preset })}
        />
      </Row>
      <Row label="Brightness" tip="Make the picture lighter or darker">
        <Slider aria-label="Brightness" min={-1} max={1} step={0.01} value={look.brightness} format={pct} onChange={(v) => set({ brightness: v })} />
      </Row>
      <Row label="Contrast" tip="Increase or soften the difference between light and dark">
        <Slider aria-label="Contrast" min={-1} max={1} step={0.01} value={look.contrast} format={pct} onChange={(v) => set({ contrast: v })} />
      </Row>
      <Row label="Saturation" tip="How vivid the colours are; all the way down is black and white">
        <Slider aria-label="Saturation" min={-1} max={1} step={0.01} value={look.saturation} format={pct} onChange={(v) => set({ saturation: v })} />
      </Row>
      <Row label="Warmth" tip="Shift the colours toward orange (warm) or blue (cool)">
        <Slider aria-label="Warmth" min={-1} max={1} step={0.01} value={look.warmth} format={pct} onChange={(v) => set({ warmth: v })} />
      </Row>
    </>
  );
}

export function Colour({ label, value, onChange, tip }: { label: string; value: string; onChange: (v: string) => void; tip?: string }) {
  return (
    <span data-tip={tip ?? label} style={{ display: "contents" }}>
      <ColorSwatchPicker aria-label={label} value={value} onChange={onChange} />
    </span>
  );
}
