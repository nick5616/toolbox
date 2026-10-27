import type { Ref } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./Select.module.css";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  id?: string;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: "sm" | "md";
  className?: string;
  ref?: Ref<HTMLSelectElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** Native <select>, restyled. React 19: `ref` is a regular prop. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  invalid,
  className,
  ref,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={cx(styles.wrap, styles[size], className)}>
      <select
        ref={ref}
        className={styles.select}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value as T)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={14} className={styles.chevron} />
    </span>
  );
}
