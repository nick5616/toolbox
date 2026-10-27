import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import styles from "./DropZone.module.css";

export interface DropZoneProps {
  /**
   * Required, unique element id. Wails reports the drop target by this id, so
   * the owning module can tell which zone received the files.
   */
  id: string;
  /** Primary text (default "Drop files here"). */
  label?: ReactNode;
  hint?: ReactNode;
  icon?: string;
  /** Extra content (e.g. a "Browse" button). */
  children?: ReactNode;
  className?: string;
}

/**
 * Local file drop target for module UIs. The `data-file-drop-target`
 * attribute makes Wails treat it as a target; while a drag is over it Wails
 * adds the `file-drop-target-active` class, which is styled here.
 */
export function DropZone({ id, label = "Drop files here", hint, icon = "arrow-down-to-line", children, className }: DropZoneProps) {
  return (
    <div id={id} data-file-drop-target="" className={cx(styles.zone, className)}>
      <Icon name={icon} size={20} className={styles.icon} />
      <div className={styles.label}>{label}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
      {children}
    </div>
  );
}
