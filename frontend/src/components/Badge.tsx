import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Mono font, for counts and versions. */
  mono?: boolean;
  className?: string;
  /** Tooltip text. */
  tip?: string;
}

export function Badge({ tone = "neutral", mono, children, className, tip }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], mono && styles.mono, className)} data-tip={tip}>
      {children}
    </span>
  );
}
