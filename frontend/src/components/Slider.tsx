import type { CSSProperties } from "react";
import { cx } from "./cx";
import styles from "./Slider.module.css";

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Formats the value shown next to the track (mono). */
  format?: (value: number) => string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

/** Native range input styled with tokens; the value is shown right-aligned in mono. */
export function Slider({ value, onChange, min, max, step, format, disabled, id, ...rest }: SliderProps) {
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
  return (
    <div className={cx(styles.root, disabled && styles.disabled)}>
      <input
        type="range"
        id={id}
        className={styles.range}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={rest["aria-label"]}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className={styles.value} htmlFor={id}>
        {format ? format(value) : String(value)}
      </output>
    </div>
  );
}
