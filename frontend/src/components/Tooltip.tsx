import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./Tooltip.module.css";

export const TOOLTIP_DELAY_MS = 400;

/** Hover/focus state that only turns on after `delay` ms. Hiding is immediate. */
export function useDelayedHover(delay: number = TOOLTIP_DELAY_MS) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { open, show, hide };
}

export interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "right";
  /** Override the 400 ms delay. */
  delay?: number;
  className?: string;
}

/** Wraps a child; shows `label` after hovering or focusing it for 400 ms. */
export function Tooltip({ label, children, side = "top", delay = TOOLTIP_DELAY_MS, className }: TooltipProps) {
  const id = useId();
  const { open, show, hide } = useDelayedHover(delay);
  return (
    <span
      className={cx(styles.wrap, className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
      onMouseDown={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span role="tooltip" id={id} className={cx(styles.bubble, styles[side])}>
          {label}
        </span>
      )}
    </span>
  );
}
