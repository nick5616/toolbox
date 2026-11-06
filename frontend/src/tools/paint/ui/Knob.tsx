import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cx } from "@/components/cx";
import styles from "./device.module.css";

export interface KnobProps {
  label: string;
  tip: string;
  /** Control position 0..1. */
  norm: number;
  /** Position of the default (for the tick and reset). */
  defaultNorm: number;
  /** Called with a new position 0..1. */
  onNorm(n: number): void;
  onReset(): void;
  /** Readout with unit. */
  text: string;
  /** One keyboard step in position units (Shift = fine). */
  step?: number;
  locked?: boolean;
  onContextMenu?(e: MouseEvent): void;
}

const ARC = 270;
const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};
const arcPath = (a0: number, a1: number) => {
  const [x0, y0] = polar(18, 18, 14, a0);
  const [x1, y1] = polar(18, 18, 14, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A 14 14 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

/** An Ableton-style rotary knob: drag up/down, Shift = fine, double-click resets, arrows/Home/End/Enter. */
export function Knob({ label, tip, norm, defaultNorm, onNorm, onReset, text, step = 0.02, locked, onContextMenu }: KnobProps) {
  const drag = useRef<{ y: number; n: number } | null>(null);
  const [active, setActive] = useState(false);
  const start = -ARC / 2;
  const at = (n: number) => start + ARC * n;
  const key = (e: KeyboardEvent) => {
    const s = e.shiftKey ? step / 5 : step;
    const map: Record<string, number | "reset"> = { ArrowUp: norm + s, ArrowRight: norm + s, ArrowDown: norm - s, ArrowLeft: norm - s, PageUp: norm + step * 5, PageDown: norm - step * 5, Home: 0, End: 1, Enter: "reset" };
    const v = map[e.key];
    if (v === undefined) return;
    e.preventDefault();
    if (v === "reset") onReset();
    else onNorm(Math.min(1, Math.max(0, v)));
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = e.shiftKey ? 0.0008 : 0.006;
    onNorm(Math.min(1, Math.max(0, d.n + (d.y - e.clientY) * k)));
  };
  return (
    <div className={styles.knobCell}>
      <div
        className={cx(styles.knob, active && styles.active)}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(norm * 100)}
        aria-valuetext={text}
        data-tip={tip}
        onKeyDown={key}
        onDoubleClick={onReset}
        onContextMenu={onContextMenu}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { y: e.clientY, n: norm };
          setActive(true);
        }}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
          setActive(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setActive(false);
        }}
      >
        <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
          <path d={arcPath(start, start + ARC)} className={styles.knobTrack} />
          {norm > 0.001 ? <path d={arcPath(start, at(norm))} className={styles.knobArc} /> : null}
          <line x1="18" y1="18" x2={polar(18, 18, 9, at(norm))[0]} y2={polar(18, 18, 9, at(norm))[1]} className={styles.knobHand} />
          <circle cx={polar(18, 18, 16.5, at(defaultNorm))[0]} cy={polar(18, 18, 16.5, at(defaultNorm))[1]} r="1" className={styles.knobTick} />
        </svg>
        {locked ? <span className={styles.pip} aria-label="Locked from Rand" /> : null}
      </div>
      <span className={styles.knobText}>{text}</span>
      <span className={styles.knobLabel}>{label}</span>
    </div>
  );
}
