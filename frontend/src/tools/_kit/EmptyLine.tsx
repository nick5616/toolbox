import type { ReactNode } from "react";
import styles from "./EmptyLine.module.css";

/** A compact one-line empty state for kit result sections (SPEC §13.1 rule 4: nothing taller than its content). */
export function EmptyLine({ title, body }: { title: ReactNode; body?: ReactNode }) {
  return (
    <p className={styles.line}>
      <span className={styles.title}>{title}</span>
      {body && <span> {body}</span>}
    </p>
  );
}
