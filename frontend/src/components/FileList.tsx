import type { ReactNode } from "react";
import { formatBytes } from "@/lib/format";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { PathText } from "./PathText";
import { cx } from "./cx";
import styles from "./FileList.module.css";

export interface FileListItem {
  /** Absolute path; also the React key. */
  path: string;
  /** Size in bytes, shown in mono if given. */
  size?: number;
  /** Icon name override (default "file"). */
  icon?: string;
  /** Trailing content, e.g. a StatusChip. */
  trailing?: ReactNode;
}

export interface FileListProps {
  files: ReadonlyArray<FileListItem>;
  /** When given, each row shows a remove button. */
  onRemove?: (path: string) => void;
  /** Shown when `files` is empty. */
  empty?: ReactNode;
  "aria-label"?: string;
  className?: string;
}

export function FileList({ files, onRemove, empty, className, ...aria }: FileListProps) {
  if (files.length === 0) {
    return empty ? <div className={cx(styles.empty, className)}>{empty}</div> : null;
  }
  return (
    <ul className={cx(styles.list, className)} {...aria}>
      {files.map((f) => (
        <li key={f.path} className={styles.row}>
          <Icon name={f.icon ?? "file"} size={14} className={styles.icon} />
          <PathText path={f.path} className={styles.path} />
          {f.size != null && <span className={styles.size}>{formatBytes(f.size)}</span>}
          {f.trailing}
          {onRemove && <IconButton size="sm" icon="x" label="Remove" onClick={() => onRemove(f.path)} />}
        </li>
      ))}
    </ul>
  );
}
