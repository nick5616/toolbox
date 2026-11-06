/**
 * The effect picker (Part B SPEC §23.8): a searchable popover anchored on the +
 * button, grouped by category, with a "Stacks" group (FX stacks and the single
 * templates) first. Type to filter, arrows move, Enter adds, Escape closes.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx, IconButton, TextField } from "@/components";
import type { EditPost } from "@/viz/edit/types";
import type { PostType } from "@/viz/types";
import { EFFECT_CATALOG, EFFECT_CATEGORIES } from "./effectCatalog";
import { FX_STACKS } from "./FxStacks";
import { EFFECT_TEMPLATES } from "./templates";
import styles from "./EffectPicker.module.css";

export const STACKS_GROUP = "Stacks";

export interface PickerEntry {
  id: string;
  label: string;
  description: string;
  group: string;
  /** Fresh effects to add: one for a single effect, several for a stack. */
  make(): EditPost[];
  count: number;
}

/** Stacks and templates first (when offered), then the effects by category. */
export function buildEntries(types: readonly PostType[], withStacks: boolean, label: (t: PostType) => string, makeEffect: (t: PostType) => EditPost): PickerEntry[] {
  const out: PickerEntry[] = [];
  if (withStacks) {
    for (const s of FX_STACKS) out.push({ id: `stack:${s.id}`, label: s.label, description: s.description, group: STACKS_GROUP, make: s.make, count: s.make().length });
    for (const t of EFFECT_TEMPLATES) out.push({ id: `tpl:${t.id}`, label: t.label, description: "One effect that reacts to the markers.", group: STACKS_GROUP, make: () => [t.make()], count: 1 });
  }
  for (const cat of EFFECT_CATEGORIES) {
    for (const t of types) {
      const info = EFFECT_CATALOG[t];
      if (info.category !== cat) continue;
      out.push({ id: `type:${t}`, label: label(t), description: info.description, group: cat, make: () => [makeEffect(t)], count: 1 });
    }
  }
  return out;
}

/** Entries whose label, description or group contain every word of the query (case-insensitive). */
export function filterEntries(entries: readonly PickerEntry[], query: string): PickerEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => {
    const hay = `${e.label} ${e.description} ${e.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface EffectPickerProps {
  types: readonly PostType[];
  /** Offer the stacks and templates (clips and adjustment clips; not the Look). */
  stacks: boolean;
  /** How many more effects the stack can take. */
  room: number;
  label: (t: PostType) => string;
  makeEffect: (t: PostType) => EditPost;
  /** The effects to add (cut down to `room`) and how many were left out. */
  onAdd(posts: EditPost[], skipped: number): void;
}

export function EffectPicker({ types, stacks, room, label, makeEffect, onAdd }: EffectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => (open ? buildEntries(types, stacks, label, makeEffect) : []), [open, types, stacks, label, makeEffect]);
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
  const cur = Math.min(active, Math.max(0, shown.length - 1));

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (open) return close(false);
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setActive(0);
    setOpen(true);
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    popRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cur, shown]);

  const choose = (e: PickerEntry) => {
    if (room <= 0) return;
    const made = e.make();
    close(true);
    onAdd(made.slice(0, room), Math.max(0, made.length - room));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setActive((cur + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[cur];
      if (item) choose(item);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  let lastGroup = "";
  return (
    <span className={styles.root}>
      <IconButton
        ref={triggerRef}
        icon="plus"
        label="Add effect"
        data-tip={room > 0 ? "Add an effect: pick one, or a ready-made stack that reacts to the music" : "This stack is full; remove an effect to add another"}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            toggle();
          }
        }}
      />
      {open && (
        <div ref={popRef} className={styles.pop} style={{ top: pos.top, right: pos.right }} onKeyDown={onKeyDown}>
          <TextField
            ref={inputRef}
            size="sm"
            icon="search"
            placeholder="Search effects"
            data-tip="Type to filter by name, description or group; Enter adds the highlighted one"
            aria-label="Search effects"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <div role="menu" aria-label="Effects" className={styles.list}>
            {shown.length === 0 && <div className={styles.empty}>No effects match.</div>}
            {shown.map((e, i) => {
              const header = e.group !== lastGroup;
              lastGroup = e.group;
              const disabled = room <= 0;
              return (
                <div key={e.id} role="none">
                  {header && <div className={styles.group}>{e.group}</div>}
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    aria-label={e.label}
                    data-tip={disabled ? "This stack is full; remove an effect first" : e.count > 1 ? `${e.description} Adds ${e.count} effects` : e.description}
                    disabled={disabled}
                    data-active={i === cur || undefined}
                    className={cx(styles.item, i === cur && styles.active)}
                    onMouseEnter={() => !disabled && setActive(i)}
                    onClick={() => choose(e)}
                  >
                    <span>{e.label}</span>
                    <span className={styles.desc}>{e.count > 1 ? `${e.description} (${e.count} effects)` : e.description}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
