import type { MeterStatus } from "./Meter";
import { cx } from "./cx";
import styles from "./StatusChip.module.css";

export type ChipStatus = MeterStatus;

const labels: Record<ChipStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const tips: Record<ChipStatus, string> = {
  queued: "Waiting for its turn to start",
  running: "In progress right now",
  done: "Finished successfully",
  failed: "Stopped with an error; open the details for why",
  cancelled: "Stopped before it finished",
};

export interface StatusChipProps {
  status: ChipStatus;
  /** Override the text (rendered uppercase). */
  label?: string;
  className?: string;
}

export function StatusChip({ status, label, className }: StatusChipProps) {
  return <span data-tip={tips[status]} className={cx(styles.chip, styles[status], className)}>{label ?? labels[status]}</span>;
}
