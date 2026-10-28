import type { ReactNode } from "react";
import { PackIcon } from "./PackIcon";
import { formatSize } from "./packSizes";
import styles from "./DiskBar.module.css";

/** Leaving less than this much free shows a warning but still allows the install. */
export const LOW_FREE_BYTES = 5e9;

export type DiskWarning = "none" | "low" | "full";

export function diskWarning(free: number, add: number): DiskWarning {
  if (add > free) return "full";
  if (add > 0 && free - add < LOW_FREE_BYTES) return "low";
  return "none";
}

export interface DiskBarProps {
  /** null while unknown (the bar is empty). */
  disk: { free: number; total: number } | null;
  /** Bytes the current selection would add. */
  add: number;
  /** The location field and its Change… button. */
  location?: ReactNode;
}

/** Segmented used / this selection / free bar with legend, free space and warnings. */
export function DiskBar({ disk, add, location }: DiskBarProps) {
  const total = disk?.total ?? 0;
  const free = disk?.free ?? 0;
  const used = Math.max(0, total - free);
  const pct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
  const warning = disk ? diskWarning(free, add) : "none";

  return (
    <section className={styles.disk} aria-label="Disk space">
      <div className={styles.bar} role="img" aria-label={disk ? `${formatSize(free)} free of ${formatSize(total)}` : "Disk space unknown"}>
        <span className={styles.used} style={{ width: `${pct(used)}%` }} />
        <span className={styles.added} style={{ width: `${pct(Math.min(add, free))}%` }} />
      </div>
      <div className={styles.row}>
        <span className={styles.legend}>
          <i className={styles.dotUsed} />
          Used
        </span>
        <span className={styles.legend}>
          <i className={styles.dotAdded} />
          These packs
        </span>
        <span className={styles.legend}>
          <i className={styles.dotFree} />
          Free
        </span>
        {warning !== "none" ? (
          <span className={styles.warn} role="status">
            <PackIcon name="triangle-alert" size={14} />
            {warning === "full" ? "Not enough space on this drive" : "That leaves less than 5 GB free"}
          </span>
        ) : null}
        <span className={styles.spacer} />
        {disk ? (
          <span className={styles.free}>
            <strong>{formatSize(free)}</strong> free of {formatSize(total)}
            {add > 0 ? ` · ${formatSize(Math.max(0, free - add))} after` : ""}
          </span>
        ) : null}
        {location}
      </div>
    </section>
  );
}
