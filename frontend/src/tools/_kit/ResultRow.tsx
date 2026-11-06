import { useRef, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { Badge, Icon, cx, splitPath, toast } from "@/components";
import { LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { startPathsDrag } from "@/lib/fileDrag";
import { FileActions } from "./FileActions";
import { formatBytes, formatResultDate } from "./format";
import styles from "./results.module.css";

export interface ResultBehaviourOptions {
  path: string;
  outputId?: string;
  missing?: boolean;
  /** Replaces the default open action (double-click / Enter). */
  onOpen?: () => void;
}

/**
 * The behaviour every result row and card shares: draggable with the file's
 * path, double-click or Enter (on the element itself) opens the file.
 * Spread the returned props on the row or card element.
 */
export function useResultBehaviour({ path, outputId, missing, onOpen }: ResultBehaviourOptions) {
  const ref = useRef<HTMLElement | null>(null);
  const open = () => {
    if (missing) return;
    if (onOpen) return onOpen();
    const p = outputId ? LibraryService.Open(outputId) : LibraryService.RevealPath(path);
    p.catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }));
  };
  return {
    ref: ref as RefObject<never>,
    "data-result-row": "",
    tabIndex: 0,
    draggable: !missing,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (missing) {
        e.preventDefault();
        return;
      }
      startPathsDrag(e, [path]);
    },
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      // A double-click on a control inside the row is that control's own business.
      if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role=slider]")) return;
      open();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Only Enter on the row itself: buttons inside keep their own Enter.
      if (e.key === "Enter" && e.target === ref.current) {
        e.preventDefault();
        open();
      }
    },
  };
}

export interface ResultRowProps {
  /** The file this row stands for. */
  path: string;
  /** Library output id; without it Open is unavailable and Reveal uses the path. */
  outputId?: string;
  /** The file was moved or deleted outside Toolbox. */
  missing?: boolean;
  /** Shown instead of the file name. */
  name?: string;
  sizeBytes?: number;
  /** Unix ms; shown as a relative time or a short date. */
  at?: number;
  /** Lucide icon (default "file"). */
  icon?: string;
  /** The tool this row belongs to (left out of Send to). Default: the kit page's tool. */
  moduleId?: string;
  /** Extra meta shown between the name and the size ("12 notes", "48 kHz"). */
  meta?: ReactNode;
  /** Extra controls placed before the file actions (e.g. Copy). */
  extra?: ReactNode;
  className?: string;
  /** Replaces the default open action (double-click / Enter). */
  onOpen?: () => void;
}

/**
 * The one result row (Phase 14, SPEC §1.C): draggable (the file travels as
 * `PATHS_MIME`), double-click or Enter opens it, **Send to** is always
 * visible (tools, new window, "Pipeline: <name>"), Reveal and Open show on
 * hover and focus, and the name, size and date use one format everywhere.
 */
export function ResultRow({ path, outputId, missing, name, sizeBytes, at, icon = "file", moduleId, meta, extra, className, onOpen }: ResultRowProps) {
  const label = name ?? splitPath(path)[1];
  const behaviour = useResultBehaviour({ path, outputId, missing, onOpen });
  return (
    <div {...behaviour} className={cx(styles.resultRow, missing && styles.missing, className)} data-missing={missing ? "" : undefined} role="group" aria-label={label}>
      <Icon name={icon} size={14} className={styles.icon} />
      <span className={styles.nameCol} data-tip={path}>
        {label}
      </span>
      {missing && (
        <Badge tone="warn" tip="The file was moved or deleted outside Toolbox">
          MISSING
        </Badge>
      )}
      {meta != null && <span className={styles.meta}>{meta}</span>}
      {sizeBytes != null && sizeBytes > 0 && (
        <span className={styles.meta} data-tip="File size on disk">
          {formatBytes(sizeBytes)}
        </span>
      )}
      {at ? (
        <span className={styles.meta} data-tip={new Date(at).toLocaleString()}>
          {formatResultDate(at)}
        </span>
      ) : null}
      <span className={styles.rowActions}>
        {extra}
        <FileActions outputId={outputId} path={path} disabled={missing} moduleId={moduleId} />
      </span>
    </div>
  );
}
