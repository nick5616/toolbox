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
  /** Tooltip text for the item. */
  tip?: string;
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
  /** In a compact toolbar, shows only the icon below 820 px (see Button's `collapsible`). */
  collapsible?: boolean;
  /** Tooltip for the trigger (default "<label> (opens a menu)"). */
  tip?: string;
  /** Same as `tip` (callers that pass the attribute form). */
  "data-tip"?: string;
}

export interface MenuPlacement {
  top?: number;
  bottom?: number;
  right: number;
  maxHeight: number;
}

const MENU_GAP = 4;
const MENU_MARGIN = 8;
/** Below this much room under the trigger, a menu opens upwards when there's more room above. */
const MENU_MIN_BELOW = 240;

/**
 * Where a menu opens for a trigger: below it when there's room (or more room than above), else above it, and
 * never taller than the window allows (the menu scrolls instead of running off the screen).
 */
export function placeMenu(r: { top: number; bottom: number; right: number }, vw: number, vh: number): MenuPlacement {
  const right = Math.max(MENU_MARGIN, vw - r.right);
  const below = vh - r.bottom - MENU_GAP - MENU_MARGIN;
  const above = r.top - MENU_GAP - MENU_MARGIN;
  if (below >= MENU_MIN_BELOW || below >= above) return { top: r.bottom + MENU_GAP, right, maxHeight: Math.max(80, below) };
  return { bottom: vh - r.top + MENU_GAP, right, maxHeight: Math.max(80, above) };
}

/**
 * A button that opens a popover menu. With `icon` and the ghost variant it
 * renders icon-only (label becomes the aria-label); otherwise a labelled button.
 */
export function MenuButton({ label, icon, items, emptyLabel = "Nothing available", size = "md", variant = "secondary", collapsible = false, tip: tipProp, "data-tip": dataTip }: MenuButtonProps) {
  const tip = tipProp ?? dataTip;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<MenuItem[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<MenuPlacement>({ top: 0, right: 0, maxHeight: 0 });
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
    if (r) setPos(placeMenu(r, window.innerWidth, window.innerHeight));
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

  // Keyboard moves keep the active item in view when the menu scrolls.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, list]);

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
    ...(icon && variant === "ghost" ? {} : { "data-tip": tip ?? `${label} (opens a menu)` }),
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: toggle,
    onKeyDown: onTriggerKey,
  };

  return (
    <span className={styles.root}>
      {icon && variant === "ghost" ? (
        <IconButton ref={triggerRef} icon={icon} label={label} size={size} variant="ghost" data-tip={tip ?? `${label} (opens a menu)`} {...triggerProps} />
      ) : (
        <Button ref={triggerRef} variant={variant} size={size} icon={icon} collapsible={collapsible} {...triggerProps}>
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
          style={{ top: pos.top, bottom: pos.bottom, right: pos.right, maxHeight: pos.maxHeight || undefined }}
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
                aria-disabled={item.disabled || undefined}
                data-active={i === active || undefined}
                data-tip={item.tip}
                data-tip-side="left"
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
