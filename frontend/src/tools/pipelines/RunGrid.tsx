import { memo, useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon, cx } from "@/components";
import { CellStatus } from "@/lib/api";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePipelines, type RunCellView, type RunItemView, type RunView } from "@/state/pipelines";
import { CellPopover } from "./CellPopover";
import { cellLook, isMergedItem, orderItems, stepName } from "./RunGridModel";
import styles from "./RunGrid.module.css";

/** Average progress of the cell's running jobs, or -1 when unknown. */
export function cellProgress(cell: RunCellView, byId: Record<string, JobView>): number {
  if (cell.status !== CellStatus.CellRunning) return -1;
  const jobs = cell.jobIds.map((id) => byId[id]).filter((j): j is JobView => !!j && isActive(j));
  if (jobs.length === 0 || jobs.some((j) => j.progress < 0)) return -1;
  return jobs.reduce((sum, j) => sum + j.progress, 0) / jobs.length;
}

interface Open {
  item: number;
  step: number;
  left: number;
  bottom: number;
}

interface RowProps {
  item: RunItemView;
  steps: RunView["steps"];
  /** Display name per step (index-aligned with `steps`). */
  stepNames: readonly string[];
  /** The step whose popover is open for this row, or -1. */
  selectedStep: number;
  onOpen: (item: number, step: number, rect: DOMRect) => void;
}

/** One item's row. Selects only its own cells' progress and is memoised, so one job's tick re-renders one row. */
const GridRow = memo(function GridRow({ item, steps, stepNames, selectedStep, onOpen }: RowProps) {
  const merged = isMergedItem(item);
  const progress = useJobs(useShallow((s) => item.cells.map((c) => cellProgress(c, s.byId))));
  return (
    <tr className={cx(merged && styles.mergedRow)}>
      <th scope="row" className={styles.rowHead} data-tip={merged ? `${item.label} (several files combined into one)` : item.label}>
        {merged && <Icon name="merge" size={12} className={styles.mergeIcon} />}
        <span className={styles.rowLabel}>{item.label}</span>
      </th>
      {steps.map((s, i) => {
        const cell = item.cells[i];
        if (!cell) return <td key={s.id} />;
        const look = cellLook(cell);
        const p = progress[i] ?? -1;
        const name = stepNames[i] ?? "";
        return (
          <td key={s.id} className={styles.cellTd}>
            <button
              type="button"
              className={cx(styles.cell, styles[look.tone], selectedStep === i && styles.selected)}
              data-status={cell.status}
              aria-label={`${name}, ${item.label}: ${look.label}`}
              data-tip={`${look.label}. Click for details, files and logs`}
              onClick={(e) => onOpen(item.index, i, e.currentTarget.getBoundingClientRect())}
            >
              <Icon name={look.icon} size={16} className={cx(look.spin && styles.spin)} />
              {p >= 0 && <span className={styles.pct}>{Math.round(p * 100)}%</span>}
            </button>
          </td>
        );
      })}
    </tr>
  );
});

/** Items down, steps across; a click on a cell opens its details. */
export function RunGrid({ run }: { run: RunView }) {
  const catalog = usePipelines((s) => s.catalog);
  const modules = useModules((s) => s.byId);
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const onOpen = useCallback((item: number, step: number, r: DOMRect) => setOpen({ item, step, left: r.left, bottom: r.bottom }), []);
  const items = useMemo(() => orderItems(run.items), [run.items]);

  // One Map lookup per tool instead of a catalogue scan per cell.
  const { toolIcon, stepNames } = useMemo(() => {
    const byType = new Map(catalog.map((t) => [t.id, t] as const));
    const toolName = (type: string) => modules[type]?.name ?? byType.get(type)?.name ?? type;
    return {
      toolIcon: (type: string) => byType.get(type)?.icon ?? modules[type]?.icon ?? "box",
      stepNames: run.steps.map((s) => stepName(s, toolName(s.type))),
    };
  }, [catalog, modules, run.steps]);
  const openItem = open ? items.find((i) => i.index === open.item) : undefined;

  return (
    <div className={styles.wrap}>
      <table className={styles.grid} aria-label="Run progress">
        <thead>
          <tr>
            <th className={styles.corner} scope="col" data-tip="Each row is one file or link; each column is a step">
              File
            </th>
            {run.steps.map((s, i) => (
              <th key={s.id} scope="col" className={styles.stepHead} data-tip={`Step ${i + 1}: ${stepNames[i]}`}>
                <Icon name={toolIcon(s.type)} size={14} />
                <span className={styles.stepNo}>{i + 1}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <GridRow
              key={item.index}
              item={item}
              steps={run.steps}
              stepNames={stepNames}
              selectedStep={open?.item === item.index ? open.step : -1}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
      {open && openItem && <CellPopover run={run} item={openItem} stepIndex={open.step} anchor={open} onClose={close} />}
    </div>
  );
}
