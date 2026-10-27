import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { Spinner } from "./Spinner";
import { cx } from "./cx";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Leading icon name (see IconName). */
  icon?: string;
  /** Shortcut hint, e.g. "Mod+Enter", rendered with Kbd. */
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, kbd, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], loading && styles.loading, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} label="Working" /> : icon ? <Icon name={icon} size={14} /> : null}
      {children != null && <span className={styles.label}>{children}</span>}
      {kbd && <Kbd combo={kbd} className={styles.kbd} />}
    </button>
  );
});
