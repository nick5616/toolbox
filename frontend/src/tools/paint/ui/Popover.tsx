/**
 * Anchored popover (SPEC §1.6). Renders inside its positioned container (the
 * editor root), so it inherits the Paint+ tokens and never needs a portal.
 * `docked` renders the same content as a static column (window width ≥ 1600).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "@/components/cx";
import { IconButton } from "./controls";
import styles from "./ui.module.css";

export type PopoverPlacement = "below-end" | "below-start" | "right-start";

export interface PopoverProps {
  open: boolean;
  title: string;
  anchor: HTMLElement | null;
  onClose(): void;
  placement?: PopoverPlacement;
  width?: number;
  maxHeight?: number;
  /** Render as a docked column instead of floating. */
  docked?: boolean;
  /** Extra header controls. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

const MARGIN = 8;

export function Popover({ open, title, anchor, onClose, placement = "below-end", width = 320, maxHeight = 520, docked, actions, className, children, ...rest }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open || docked) return;
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || !anchor) {
      setPos({ right: MARGIN, top: 56, width, maxHeight });
      return;
    }
    const pr = parent.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = Math.min(width, Math.max(160, pr.width - MARGIN * 2));
    const mh = Math.min(maxHeight, Math.max(160, pr.height - MARGIN * 2));
    let left = placement === "below-end" ? ar.right - pr.left - w : placement === "below-start" ? ar.left - pr.left : ar.right - pr.left + MARGIN;
    let top = placement === "right-start" ? ar.top - pr.top : ar.bottom - pr.top + MARGIN;
    left = Math.max(MARGIN, Math.min(left, pr.width - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, pr.height - Math.min(mh, 200) - MARGIN));
    setPos({ left, top, width: w, maxHeight: Math.min(mh, pr.height - top - MARGIN) });
  }, [open, docked, anchor, placement, width, maxHeight]);

  useEffect(() => {
    if (!open || docked) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // A click on another popover trigger or a dialog is theirs.
      if ((t as HTMLElement).closest?.("[data-popover-keep]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, docked, anchor, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role={docked ? "region" : "dialog"}
      aria-label={title}
      className={cx(styles.popover, docked && styles.docked, className)}
      style={docked ? { width } : pos}
      data-testid={rest["data-testid"]}
      data-docked={docked ? "true" : "false"}
    >
      <div className={styles.popHead}>
        <span>{title}</span>
        <span className={styles.row}>
          {actions}
          <IconButton icon="close" label={`Close ${title}`} size="sm" onClick={onClose} />
        </span>
      </div>
      <div className={styles.popBody}>{children}</div>
    </div>
  );
}
