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
  /**
   * Inside a compact toolbar (an ancestor with `container: toolbar-compact / inline-size`)
   * the label hides below 820 px and only
   * the icon shows; the label becomes the tooltip and accessible name.
   */
  collapsible?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, kbd, collapsible = false, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], loading && styles.loading, collapsible && icon && styles.collapsible, className)}
      title={collapsible && typeof children === "string" && rest.title === undefined ? children : rest.title}
      aria-label={collapsible && typeof children === "string" && rest["aria-label"] === undefined ? children : rest["aria-label"]}
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
