import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./Spinner.module.css";

export interface SpinnerProps {
  size?: number;
  /** Accessible label (default "Loading"). */
  label?: string;
  className?: string;
}

/** Use sparingly; prefer a Meter for anything with progress. */
export function Spinner({ size = 16, label = "Loading", className }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={cx(styles.spinner, className)}>
      <Icon name="loader-circle" size={size} />
    </span>
  );
}
