import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./TextField.module.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  /** Mono font (paths, URLs, numbers). */
  mono?: boolean;
  /** Leading icon name. */
  icon?: string;
  /** Trailing slot (e.g. an IconButton). */
  trailing?: ReactNode;
  size?: "sm" | "md";
  /** Class for the outer wrapper (`className` goes to the input). */
  wrapperClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { invalid, mono, icon, trailing, size = "md", className, wrapperClassName, type = "text", ...rest },
  ref,
) {
  return (
    <span className={cx(styles.wrap, styles[size], invalid && styles.invalid, wrapperClassName)}>
      {icon && <Icon name={icon} size={14} className={styles.icon} />}
      <input
        ref={ref}
        type={type}
        aria-invalid={invalid || undefined}
        className={cx(styles.input, mono && styles.mono, className)}
        {...rest}
      />
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </span>
  );
});
