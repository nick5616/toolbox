import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Dialog.module.css";

export interface DialogProps {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  /** Esc. Omit for dialogs that only close through their buttons. */
  onEscape?: () => void;
  /** Enter outside a button. */
  onEnter?: () => void;
  /** The click on the backdrop. */
  onBackdrop?: () => void;
  width?: number;
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)";

/** A small modal for this tool: focus-trapped, Esc and Enter optional. */
export function Dialog({ title, children, footer, onEscape, onEnter, onBackdrop, width = 420 }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input:not(:disabled)") ?? panel.current;
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else if (e.key === "Enter" && onEnter) {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      onEnter();
    } else if (e.key === "Tab") {
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <div className={styles.backdrop} onMouseDown={onBackdrop}>
      <div
        ref={panel}
        className={styles.panel}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
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
        <div className={styles.footer}>{footer}</div>
      </div>
    </div>
  );
}
