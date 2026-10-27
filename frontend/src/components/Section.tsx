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
}

export function Section({ label, children, action, className }: SectionProps) {
  const id = useId();
  return (
    <section className={cx(styles.section, className)} aria-labelledby={id}>
      <header className={styles.header}>
        <h3 id={id} className={styles.label}>
          {label}
        </h3>
        {action && <div className={styles.action}>{action}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
