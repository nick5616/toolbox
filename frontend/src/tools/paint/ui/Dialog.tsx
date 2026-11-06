import { useEffect, useRef, type ReactNode } from "react";
import styles from "./ui.module.css";

export interface DialogProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  actions: ReactNode;
  width?: number;
}

/** A modal over the editor root (absolute, so it keeps the Paint+ tokens). */
export function Dialog({ title, onClose, children, actions, width }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>("input, select, button:not([data-dialog-close])")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className={styles.scrim} data-popover-keep onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <h2>{title}</h2>
        <div className={styles.dialogBody}>{children}</div>
        <div className={styles.dialogActions}>{actions}</div>
      </div>
    </div>
  );
}
