import { useEffect, useState, type KeyboardEvent } from "react";
import { cx } from "./cx";
import styles from "./Stepper.module.css";

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name for the number field. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  /** Small unit text after the number, e.g. "px". */
  unit?: string;
  disabled?: boolean;
  className?: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function Stepper({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  disabled,
  className,
  ...aria
}: StepperProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const set = (n: number) => {
    const next = clamp(n, min, max);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) setDraft(String(value));
    else set(parsed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      set(value + step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      set(value - step);
    } else if (e.key === "Enter") {
      commit();
    }
  };

  return (
    <span className={cx(styles.root, disabled && styles.disabled, className)}>
      <button
        type="button"
        className={styles.btn}
        aria-label="Decrease"
        tabIndex={-1}
        disabled={disabled || value <= min}
        onClick={() => set(value - step)}
      >
        −
      </button>
      <input
        className={styles.input}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        {...aria}
      />
      {unit && <span className={styles.unit}>{unit}</span>}
      <button
        type="button"
        className={styles.btn}
        aria-label="Increase"
        tabIndex={-1}
        disabled={disabled || value >= max}
        onClick={() => set(value + step)}
      >
        +
      </button>
    </span>
  );
}
