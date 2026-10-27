import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Spinner } from "./Spinner";
import { cx } from "./cx";
import styles from "./MenuButton.module.css";

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuButtonProps {
  label: string;
  icon?: string;
  /** Items are computed lazily when the menu opens (may be async). */
  items: () => MenuItem[] | Promise<MenuItem[]>;
  /** Shown when items() resolves empty. */
  emptyLabel?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
}

/**
 * A button that opens a popover menu. With `icon` and the ghost variant it
 * renders icon-only (label becomes the aria-label); otherwise a labelled button.
 */
export function MenuButton({ label, icon, items, emptyLabel = "Nothing available", size = "md", variant = "secondary" }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<MenuItem[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const close = useCallback((refocus: boolean) => {
    seq.current++;
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close(false);
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    const my = ++seq.current;
    setOpen(true);
    setLoading(true);
    setList([]);
    setActive(0);
    Promise.resolve()
      .then(items)
      .then((res) => {
        if (seq.current !== my) return;
        setList(res);
        setActive(Math.max(0, res.findIndex((i) => !i.disabled)));
      })
      .catch(() => {
        if (seq.current === my) setList([]);
      })
      .finally(() => {
        if (seq.current === my) setLoading(false);
      });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open, loading]);

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  const step = (dir: 1 | -1) => {
    if (list.length === 0) return;
    let i = active;
    for (let n = 0; n < list.length; n++) {
      i = (i + dir + list.length) % list.length;
      if (!list[i]!.disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = list[active];
      if (item) select(item);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      toggle();
    }
  };

  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: toggle,
    onKeyDown: onTriggerKey,
  };

  return (
    <span className={styles.root}>
      {icon && variant === "ghost" ? (
        <IconButton ref={triggerRef} icon={icon} label={label} size={size} variant="ghost" {...triggerProps} />
      ) : (
        <Button ref={triggerRef} variant={variant} size={size} icon={icon} {...triggerProps}>
          {label}
        </Button>
      )}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className={styles.menu}
          style={{ top: pos.top, right: pos.right }}
          onKeyDown={onKeyDown}
        >
          {loading ? (
            <div className={styles.status}>
              <Spinner size={14} />
            </div>
          ) : list.length === 0 ? (
            <div className={styles.status}>{emptyLabel}</div>
          ) : (
            list.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                data-active={i === active || undefined}
                className={cx(styles.item, i === active && styles.active)}
                onMouseEnter={() => !item.disabled && setActive(i)}
                onClick={() => select(item)}
              >
                {item.icon && <Icon name={item.icon} size={14} />}
                <span>{item.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </span>
  );
}
