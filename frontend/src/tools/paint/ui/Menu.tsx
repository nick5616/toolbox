import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/components/cx";
import { IconButton, type IconButtonProps } from "./controls";
import { PaintIcon } from "./icons";
import { Popover, type PopoverPlacement } from "./Popover";
import styles from "./ui.module.css";

export type MenuEntry =
  | { kind: "head"; label: string }
  | { kind: "sep" }
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: string;
      kbd?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Shown as the tooltip when disabled. */
      reason?: string;
      checked?: boolean;
      onSelect(): void;
    };

export const item = (id: string, label: string, onSelect: () => void, extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {}): MenuEntry => ({ kind: "item", id, label, onSelect, ...extra });
export const head = (label: string): MenuEntry => ({ kind: "head", label });
export const sep = (): MenuEntry => ({ kind: "sep" });

export interface MenuProps {
  open: boolean;
  title: string;
  anchor: HTMLElement | null;
  entries: MenuEntry[];
  onClose(): void;
  placement?: PopoverPlacement;
  width?: number;
}

/** A keyboard-navigable menu in a popover (arrows, Home/End, Enter, Escape). */
export function Menu({ open, title, anchor, entries, onClose, placement = "below-start", width = 240 }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };
  return (
    <Popover open={open} title={title} anchor={anchor} onClose={onClose} placement={placement} width={width} maxHeight={560}>
      <div ref={listRef} role="menu" aria-label={title} className={styles.menu} onKeyDown={onKey} style={{ margin: "-6px -12px -12px" }}>
        {entries.map((e, n) => {
          if (e.kind === "sep") return <div key={`s${n}`} className={styles.menuSep} role="separator" />;
          if (e.kind === "head") return <div key={`h${n}`} className={styles.menuHead}>{e.label}</div>;
          return (
            <button
              key={e.id}
              type="button"
              role={e.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={e.checked}
              aria-disabled={e.disabled || undefined}
              data-tip={e.disabled && e.reason ? e.reason : e.label}
              className={cx(styles.menuItem, e.danger && styles.danger)}
              onClick={() => {
                if (e.disabled) return;
                onClose();
                e.onSelect();
              }}
            >
              {e.icon ? <PaintIcon name={e.icon} size={16} /> : e.checked !== undefined ? <PaintIcon name={e.checked ? "check" : "minus"} size={16} /> : null}
              <span className={styles.grow}>{e.label}</span>
              {e.kbd ? <kbd>{e.kbd}</kbd> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

/** An icon button that opens a Menu under itself. */
export function MenuButton({ entries, title, placement, children, ...btn }: Omit<IconButtonProps, "onClick" | "pressed"> & { entries: MenuEntry[]; title: string; placement?: PopoverPlacement; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton ref={setEl} {...btn} pressed={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu open={open} title={title} anchor={el} entries={entries} onClose={() => setOpen(false)} placement={placement} />
      {children}
    </>
  );
}
