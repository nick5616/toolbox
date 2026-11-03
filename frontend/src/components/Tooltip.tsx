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

/**
 * Wraps a child with a tooltip. String labels go through the window-wide
 * TooltipLayer (never clipped); other content keeps a local bubble.
 */
export function Tooltip({ label, children, side = "top", delay = TOOLTIP_DELAY_MS, className }: TooltipProps) {
  if (typeof label === "string") {
    return (
      <span className={cx(styles.wrap, className)} data-tip={label} data-tip-side={side}>
        {children}
      </span>
    );
  }
  return <LocalTooltip label={label} side={side} delay={delay} className={className}>{children}</LocalTooltip>;
}

function LocalTooltip({ label, children, side = "top", delay = TOOLTIP_DELAY_MS, className }: TooltipProps) {
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
