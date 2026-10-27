import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./Banner.module.css";

export type BannerTone = "info" | "warn" | "danger";

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Right-aligned slot, typically a Button. */
  action?: ReactNode;
  className?: string;
}

const iconFor: Record<BannerTone, string> = {
  info: "info",
  warn: "triangle-alert",
  danger: "circle-alert",
};

export function Banner({ tone = "info", title, children, action, className }: BannerProps) {
  return (
    <div role={tone === "info" ? "status" : "alert"} className={cx(styles.banner, styles[tone], className)}>
      <Icon name={iconFor[tone]} size={16} className={styles.icon} />
      <div className={styles.content}>
        {title && <div className={styles.title}>{title}</div>}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
