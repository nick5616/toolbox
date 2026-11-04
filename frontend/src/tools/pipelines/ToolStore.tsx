import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, TextField, cx } from "@/components";
import type { StepType } from "@/lib/api";
import type { ModuleView } from "@/state/modules";
import { storeContents } from "./toolStoreModel";
import styles from "./GraphEditor.module.css";

export const DRAG_TYPE = "application/x-toolbox-step";

/** A small card that follows the cursor while a tool is dragged. */
function dragGhost(dt: DataTransfer, name: string) {
  if (typeof dt.setDragImage !== "function") return;
  const el = document.createElement("div");
  el.className = styles.ghost ?? "";
  el.textContent = name;
  document.body.appendChild(el);
  dt.setDragImage(el, 16, 16);
  window.setTimeout(() => el.remove(), 0);
}

export interface ToolStoreProps {
  catalog: readonly StepType[];
  modules: readonly ModuleView[];
  /** Click or Enter on a tool adds it (dragging it onto the canvas places it). */
  onAdd: (type: StepType) => void;
}

/** The tool store (SPEC.md §12): every step type, by group, searchable; drag one onto the canvas. */
export function ToolStore({ catalog, modules, onAdd }: ToolStoreProps) {
  const [query, setQuery] = useState("");
  const contents = useMemo(() => storeContents(catalog, modules, query), [catalog, modules, query]);
  return (
    <aside className={styles.store} aria-label="Tool store">
      <TextField icon="search" size="sm" placeholder="Search tools" aria-label="Search tools" data-tip="Find a tool to add to the graph" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={styles.storeList}>
        {contents.groups.length === 0 && contents.unavailable.length === 0 && <div className={styles.storeNone}>No tools match</div>}
        {contents.groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className={styles.groupLabel}>{g.label}</div>
            {g.tools.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.tool}
                draggable
                data-tool-id={t.id}
                data-tip={`${t.description} Drag it onto the canvas, or click to add.`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, t.id);
                  e.dataTransfer.effectAllowed = "copy";
                  dragGhost(e.dataTransfer, t.name);
                }}
                onClick={() => onAdd(t)}
              >
                <Icon name={t.icon} size={16} className={styles.toolIcon} />
                <span className={styles.toolText}>
                  <span className={styles.toolName}>{t.name}</span>
                  <span className={styles.toolDesc}>{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
        {contents.unavailable.length > 0 && (
          <div role="group" aria-label="Not available as steps">
            <div className={styles.groupLabel}>Not available as steps</div>
            {contents.unavailable.map((t) => (
              <div key={t.id} className={cx(styles.tool, styles.toolOff)} aria-disabled="true" data-tool-id={t.id} data-tip={t.reason}>
                <Icon name={t.icon} size={16} className={styles.toolIcon} />
                <span className={styles.toolText}>
                  <span className={styles.toolName}>{t.name}</span>
                  <span className={styles.toolDesc}>{t.reason}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

export interface QuickAddProps {
  catalog: readonly StepType[];
  /** Position inside the canvas, in CSS pixels. */
  x: number;
  y: number;
  onPick: (type: StepType) => void;
  onClose: () => void;
}

/** The popover a double-click on the empty canvas opens: search, Enter adds the first match. */
export function QuickAdd({ catalog, x, y, onPick, onClose }: QuickAddProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tools = useMemo(() => storeContents(catalog, [], query).groups.flatMap((g) => g.tools), [catalog, query]);
  useEffect(() => input.current?.focus(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      const first = tools[0];
      if (first) {
        e.preventDefault();
        onPick(first);
      }
    }
  };
  return (
    <div className={styles.quick} style={{ left: x, top: y }} role="dialog" aria-label="Add a tool" onKeyDown={onKeyDown} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <TextField ref={input} icon="search" size="sm" placeholder="Add a tool…" aria-label="Search tools to add" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={styles.quickList}>
        {tools.length === 0 && <div className={styles.storeNone}>No tools match</div>}
        {tools.map((t) => (
          <button key={t.id} type="button" className={styles.tool} data-tip={t.description} onClick={() => onPick(t)}>
            <Icon name={t.icon} size={16} className={styles.toolIcon} />
            <span className={styles.toolText}>
              <span className={styles.toolName}>{t.name}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
