import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./IconButton.module.css";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** Required: used as aria-label and tooltip text. */
  label: string;
  /** Icon name (see IconName). */
  icon: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary" | "danger";
  /** Optional shortcut shown in the tooltip. */
  kbd?: string;
  /** Toggled-on appearance (e.g. active panel). */
  pressed?: boolean;
  tooltipSide?: "top" | "bottom" | "right";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", variant = "ghost", kbd, pressed, tooltipSide, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      data-tip-kbd={kbd}
      data-tip-side={tooltipSide}
      className={cx(styles.button, styles[size], styles[variant], pressed && styles.pressed, className)}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
  );
});
