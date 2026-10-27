import { cx } from "./cx";
import styles from "./Meter.module.css";

export type MeterStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface MeterProps {
  /** 0..1, or -1 for indeterminate (sweep; only while `running`). */
  value: number;
  status?: MeterStatus;
  size?: "sm" | "md";
  /** Accessible name (default "Progress"). */
  label?: string;
  className?: string;
}

/** Segmented DAW-style meter (SPEC 8.4 signature element 1). */
export function Meter({ value, status = "running", size = "md", label = "Progress", className }: MeterProps) {
  const indeterminate = value < 0 && status === "running";
  let ratio: number;
  if (indeterminate) ratio = 0.3;
  else if (value < 0 || Number.isNaN(value)) ratio = status === "done" ? 1 : 0;
  else ratio = Math.min(1, value);
  const pct = Math.round(ratio * 1000) / 10;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
      aria-busy={status === "running" || undefined}
      className={cx(styles.meter, styles[size], styles[status], indeterminate && styles.indeterminate, className)}
    >
      <div className={styles.fill} style={{ width: `${pct}%` }} />
    </div>
  );
}
