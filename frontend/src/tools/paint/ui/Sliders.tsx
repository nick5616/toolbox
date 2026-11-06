import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import styles from "./ui.module.css";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface VerticalSliderProps {
  label: string;
  /** 0..1 (top = 1). */
  value: number;
  onChange(v: number): void;
  height?: number;
  /** Text for the value bubble ("24 px", "80%"). */
  format?(v: number): string;
  kbd?: string;
  "data-testid"?: string;
}

/** Procreate-style size/opacity slider with a value bubble while dragging. */
export function VerticalSlider({ label, value, onChange, height = 160, format = (v) => `${Math.round(v * 100)}%`, kbd, ...rest }: VerticalSliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const from = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.height === 0) return;
    onChange(clamp01(1 - (e.clientY - r.top) / r.height));
  };
  const key = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 0.1 : 0.02;
    const map: Record<string, number> = { ArrowUp: value + big, ArrowRight: value + big, ArrowDown: value - big, ArrowLeft: value - big, PageUp: value + 0.1, PageDown: value - 0.1, Home: 0, End: 1 };
    const n = map[e.key];
    if (n === undefined) return;
    e.preventDefault();
    onChange(clamp01(n));
  };
  const pct = clamp01(value) * 100;
  return (
    <div
      ref={ref}
      className={styles.vslider}
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={format(value)}
      data-tip={label}
      data-tip-kbd={kbd}
      data-tip-side="right"
      data-testid={rest["data-testid"]}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag(true);
        from(e);
      }}
      onPointerMove={(e) => drag && from(e)}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onKeyDown={key}
    >
      <div className={styles.vtrack}>
        <div className={styles.vfill} style={{ height: `${pct}%` }} />
      </div>
      <div className={styles.vknob} style={{ bottom: `${pct}%` }} />
      {drag ? (
        <div className={styles.bubble} style={{ bottom: `${pct}%` }} role="status">
          {format(value)}
        </div>
      ) : null}
    </div>
  );
}

export interface HSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(v: number): void;
  /** Tooltip; defaults to the label. */
  tip?: string;
  format?(v: number): string;
}

/** A labelled horizontal slider with a typed value, for panels. */
export function HSlider({ label, value, min, max, step = (max - min) / 100, onChange, tip, format }: HSliderProps) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return (
    <div className={styles.hrow}>
      <span className={styles.lab} data-tip={tip ?? label}>
        {label}
      </span>
      <input
        className={styles.hslider}
        type="range"
        aria-label={label}
        aria-valuetext={format ? format(value) : undefined}
        data-tip={tip ?? label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className={styles.num}
        type="number"
        aria-label={`${label} value`}
        data-tip={`${label} (${min}–${max})`}
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(digits))}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
    </div>
  );
}
