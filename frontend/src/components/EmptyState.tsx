import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  /** Icon name (see IconName). */
  icon?: string;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** `lg` uses the 28px hero title (empty and coming-soon screens). */
  size?: "md" | "lg";
  className?: string;
}

export function EmptyState({ icon, title, body, action, size = "md", className }: EmptyStateProps) {
  return (
    <div className={cx(styles.root, styles[size], className)}>
      {icon && (
        <span className={styles.iconWrap}>
          <Icon name={icon} size={size === "lg" ? 28 : 20} />
        </span>
      )}
      <h2 className={styles.title}>{title}</h2>
      {body && <p className={styles.body}>{body}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
