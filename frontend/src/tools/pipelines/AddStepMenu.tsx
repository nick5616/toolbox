import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, TextField, Tooltip, cx } from "@/components";
import type { PipelineCheck, StepType } from "@/lib/api";
import { compatibleAt } from "@/pipelines/compat";
import { acceptsNoun, CATEGORY_LABELS, CATEGORY_ORDER, NO_FILES_TYPES } from "./editorModel";
import styles from "./AddStepMenu.module.css";

export interface AddStepMenuProps {
  /** Position the new step takes (0 = first). */
  index: number;
  catalog: readonly StepType[];
  check: PipelineCheck | undefined;
  onPick: (type: StepType) => void;
  /** "end" is the big button after the last card; "between" is the hover button between cards. */
  variant: "end" | "between";
}

interface Entry {
  type: StepType;
  compatible: boolean;
  reason: string;
}

interface Group {
  id: string;
  label: string;
  entries: Entry[];
}

/** Whether a step type can read what exists before `index` (at the start it reads the run's inputs). */
function isCompatible(t: StepType, check: PipelineCheck | undefined, index: number): boolean {
  if (index === 0 || NO_FILES_TYPES.has(t.id)) return true;
  return compatibleAt(check, index, t.accepts);
}

/** Groups the catalogue for the menu: built-ins first, then tools by category; compatible first. */
export function menuGroups(catalog: readonly StepType[], check: PipelineCheck | undefined, index: number, query: string): Group[] {
  const q = query.trim().toLowerCase();
  const matches = (t: StepType) => q === "" || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  const entries: Entry[] = catalog.filter(matches).map((type) => {
    const compatible = isCompatible(type, check, index);
    const noun = acceptsNoun(type);
    return { type, compatible, reason: compatible ? "" : `Reads ${noun}; nothing earlier makes ${noun}` };
  });
  const ordered = (list: Entry[]) => [...list.filter((e) => e.compatible), ...list.filter((e) => !e.compatible)];
  const groups: Group[] = [];
  const builtins = entries.filter((e) => e.type.builtin);
  if (builtins.length > 0) groups.push({ id: "builtin", label: "Pipeline steps", entries: builtins });
  const tools = entries.filter((e) => !e.type.builtin);
  const cats = [...CATEGORY_ORDER, ...tools.map((e) => e.type.category as string)].filter((c, i, a) => a.indexOf(c) === i);
  for (const c of cats) {
    const list = tools.filter((e) => e.type.category === c);
    if (list.length > 0) groups.push({ id: c, label: CATEGORY_LABELS[c] ?? c, entries: ordered(list) });
  }
  return groups;
}

/** The "+ Add step" popover (SPEC.md §11.3). */
export function AddStepMenu({ index, catalog, check, onPick, variant }: AddStepMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => (open ? menuGroups(catalog, check, index, query) : []), [open, catalog, check, index, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 360));
      const below = r.bottom + 4;
      const top = below + 420 > window.innerHeight ? Math.max(8, window.innerHeight - 424) : below;
      setPos({ top, left });
    }
    setQuery("");
    setOpen(true);
  };

  const pick = (t: StepType) => {
    setOpen(false);
    onPick(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "Enter" && e.target === searchRef.current) {
      e.preventDefault();
      const first = groups.flatMap((g) => g.entries)[0];
      if (first) pick(first.type);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("input, [role=menuitem]") ?? []);
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const trigger =
    variant === "end" ? (
      <button ref={triggerRef} type="button" className={styles.endButton} aria-haspopup="menu" aria-expanded={open} data-tip="Choose a tool or action to add as the next step" onClick={toggle}>
        <Icon name="plus" size={14} />
        <span>Add step</span>
      </button>
    ) : (
      <Tooltip label="Add a step here">
        <button
          ref={triggerRef}
          type="button"
          className={styles.betweenButton}
          aria-label="Add step here"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="plus" size={12} />
        </button>
      </Tooltip>
    );

  return (
    <span className={cx(styles.root, variant === "between" && styles.between, open && styles.open)}>
      {trigger}
      {open && (
        <div ref={panelRef} className={styles.panel} style={{ top: pos.top, left: pos.left }} role="menu" aria-label="Add step" onKeyDown={onKeyDown}>
          <TextField
            ref={searchRef}
            icon="search"
            size="sm"
            placeholder="Search steps"
            aria-label="Search steps"
            data-tip="Type a tool name or what you want to do"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className={styles.list}>
            {groups.length === 0 && <div className={styles.none}>No steps match</div>}
            {groups.map((g) => (
              <div key={g.id} role="group" aria-label={g.label}>
                <div className={styles.groupLabel}>{g.label}</div>
                {g.entries.map((e) => (
                  <button
                    key={e.type.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={cx(styles.item, !e.compatible && styles.dim)}
                    title={e.reason || e.type.description}
                    onClick={() => pick(e.type)}
                  >
                    <Icon name={e.type.icon} size={16} className={styles.itemIcon} />
                    <span className={styles.itemText}>
                      <span className={styles.itemName}>{e.type.name}</span>
                      <span className={styles.itemDesc}>{e.reason || e.type.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
