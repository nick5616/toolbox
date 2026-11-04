import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components";
import styles from "./Modal.module.css";

export interface ModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  wide?: boolean;
}

/** A small modal dialog (ConfirmDialog's look, with content). */
export function Modal({ title, children, confirmLabel, confirmDisabled, onConfirm, onCancel, wide }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div className={styles.backdrop} onMouseDown={onCancel}>
      <div
        ref={panelRef}
        className={wide ? `${styles.panel} ${styles.wide}` : styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        <div className={styles.footer}>
          <Button variant="secondary" data-tip="Close without making changes" kbd="Esc" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" data-tip={confirmDisabled ? "Fill in the missing details first" : undefined} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
