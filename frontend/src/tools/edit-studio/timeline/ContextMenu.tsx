/** A small right-click menu for the tracks (Phase 9 SPEC §14.5). Closes on Escape, outside press or a choice. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components";
import styles from "./ContextMenu.module.css";

export interface ContextItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  /** A divider is drawn above it. */
  separator?: boolean;
  onSelect: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y, items.length]);

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={styles.menu} style={pos} role="menu" tabIndex={-1} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <div key={it.id} role="none">
          {it.separator && <div className={styles.sep} role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className={styles.icon}>{it.icon && <Icon name={it.icon} size={14} />}</span>
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
