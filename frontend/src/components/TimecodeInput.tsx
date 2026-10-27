import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./TimecodeInput.module.css";

export interface TimecodeInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size"> {
  /** Raw text, e.g. "1:05.5". Parsing/validation belongs to the caller. */
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

/** Counter-style mono input for timecodes (SPEC 8.4 signature element 3). */
export const TimecodeInput = forwardRef<HTMLInputElement, TimecodeInputProps>(function TimecodeInput(
  { value, onChange, invalid, className, placeholder = "0:00.0", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      className={cx(styles.input, invalid && styles.invalid, className)}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
});
