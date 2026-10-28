import { useRef, type KeyboardEvent } from "react";
import { cx } from "@/components";
import styles from "./image.module.css";

export interface RadioCardOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  note?: string;
}

export interface RadioCardsProps<T extends string> {
  options: ReadonlyArray<RadioCardOption<T>>;
  value: T;
  onChange: (v: T) => void;
  "aria-label": string;
}

/** Radio-group of cards (roving tabindex, arrow keys). */
export function RadioCards<T extends string>({ options, value, onChange, ...aria }: RadioCardsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.findIndex((o) => o.value === value);
  const tabbable = selected >= 0 ? selected : 0;

  const move = (from: number, dir: 1 | -1) => {
    const i = (from + dir + options.length) % options.length;
    const o = options[i];
    if (!o) return;
    onChange(o.value);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    }
  };

  return (
    <div role="radiogroup" aria-label={aria["aria-label"]} className={styles.cards}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabbable ? 0 : -1}
          className={cx(styles.card, o.value === value && styles.selected)}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className={styles.cardLabel}>{o.label}</span>
          {o.hint && <span className={styles.cardNote}>{o.hint}</span>}
          {o.note && <span className={styles.cardNote}>{o.note}</span>}
        </button>
      ))}
    </div>
  );
}
