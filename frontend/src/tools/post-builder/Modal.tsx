import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components";
import styles from "./Modal.module.css";

export interface ModalProps {
  title: string;
  children: ReactNode;
  /** Primary action; omit for a dialog with only Cancel. */
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
  wide?: boolean;
}

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

/** A small modal: Esc closes, Tab stays inside. */
export function Modal({ title, children, confirmLabel, confirmDisabled, onConfirm, onClose, wide }: ModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea");
    (first ?? panel.current)?.focus();
    return () => prev?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && onConfirm && !confirmDisabled && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      onConfirm();
    } else if (e.key === "Tab") {
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={panel}
        className={wide ? `${styles.panel} ${styles.wide}` : styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        <div className={styles.footer}>
          <Button variant="secondary" data-tip="Close without making changes" kbd="Esc" onClick={onClose}>
            Cancel
          </Button>
          {confirmLabel && onConfirm && (
            <Button variant="primary" data-tip={confirmDisabled ? "Fill in the missing details first" : undefined} disabled={confirmDisabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
