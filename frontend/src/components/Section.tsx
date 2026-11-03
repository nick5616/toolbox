import { useId, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./Section.module.css";

export interface SectionProps {
  /** Silkscreen label. */
  label: ReactNode;
  children: ReactNode;
  /** Right-aligned slot beside the label. */
  action?: ReactNode;
  className?: string;
  /** Tooltip on the label: what this section is for. */
  tip?: string;
}

export function Section({ label, children, action, className, tip }: SectionProps) {
  const id = useId();
  return (
    <section className={cx(styles.section, className)} aria-labelledby={id}>
      <header className={styles.header}>
        <h3 id={id} className={styles.label} data-tip={tip}>
          {label}
        </h3>
        {action && <div className={styles.action}>{action}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
