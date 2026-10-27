import { useRef, type KeyboardEvent } from "react";
import { cx } from "./cx";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  disabled = false,
  fullWidth = false,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, dir: 1 | -1 | "first" | "last") => {
    const n = options.length;
    const enabled = (i: number) => !options[i]?.disabled;
    let next = from;
    if (dir === "first") next = options.findIndex((_, i) => enabled(i));
    else if (dir === "last") next = options.findLastIndex((_, i) => enabled(i));
    else {
      for (let step = 1; step <= n; step++) {
        const i = (from + dir * step + n * step) % n;
        if (enabled(i)) {
          next = i;
          break;
        }
      }
    }
    const opt = options[next];
    if (!opt || next < 0 || next === from) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(index, -1);
        break;
      case "Home":
        e.preventDefault();
        move(index, "first");
        break;
      case "End":
        e.preventDefault();
        move(index, "last");
        break;
    }
  };

  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabbable = selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled);

  return (
    <div
      role="radiogroup"
      className={cx(styles.root, styles[size], fullWidth && styles.full, disabled && styles.disabled, className)}
      {...aria}
    >
      {options.map((opt, i) => {
        const checked = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabbable ? 0 : -1}
            disabled={disabled || opt.disabled}
            className={cx(styles.option, checked && styles.checked)}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
