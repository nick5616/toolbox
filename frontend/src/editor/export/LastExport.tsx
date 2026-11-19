/**
 * A finished export as a compact result row (Phase 14, SPEC §1.C): the file's
 * name with the kit's file actions (Reveal, Open, Send to…) and a dismiss
 * button. The row is a drag source: dropping it on a tool, a media bin or a
 * pipeline hands the file(s) over. Shared by the workspace tools, so it lives
 * with the editor (shared code may use the kit's `FileActions`).
 */
import type { ReactNode } from "react";
import { Icon, IconButton } from "@/components";
import { displayPath } from "@/lib/displayPath";
import { startPathsDrag } from "@/lib/fileDrag";
import { FileActions } from "@/tools/_kit";
import styles from "./LastExport.module.css";

export interface LastExportProps {
  /** The file (or folder) the actions work on. */
  path: string;
  /** Library output id, when the file is registered. */
  outputId?: string;
  missing?: boolean;
  /** The tool that made it (left out of "Send to"). */
  moduleId: string;
  /** What a drag carries; default `[path]`. */
  dragPaths?: readonly string[];
  /** "Last export" by default. */
  label?: string;
  /** Shown instead of the file name. */
  name?: string;
  /** Small trailing note ("rendered ×3.2 real time"). */
  note?: string;
  icon?: string;
  /** Extra actions after the file actions (e.g. Open folder for a multi-file export). */
  extra?: ReactNode;
  onDismiss?(): void;
}

export const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p;

export function LastExport({ path, outputId, missing, moduleId, dragPaths, label = "Last export", name, note, icon = "check", extra, onDismiss }: LastExportProps) {
  const paths = dragPaths && dragPaths.length > 0 ? dragPaths : [path];
  return (
    <div
      className={styles.row}
      role="group"
      aria-label={label}
      data-testid="last-export"
      draggable={!missing}
      onDragStart={(e) => startPathsDrag(e, paths)}
    >
      <Icon name={icon} size={14} />
      <span className={styles.label}>{label}</span>
      <span className={styles.name} data-tip={displayPath(path)}>
        {name ?? baseName(path)}
      </span>
      {note ? <span className={styles.note}>{note}</span> : null}
      <FileActions outputId={outputId} path={path} disabled={missing} moduleId={moduleId} />
      {extra}
      {onDismiss ? <IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this row; the file stays in your library" onClick={onDismiss} /> : null}
    </div>
  );
}
