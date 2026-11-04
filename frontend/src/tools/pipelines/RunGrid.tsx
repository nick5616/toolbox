import { useCallback, useMemo, useState } from "react";
import { Icon, cx } from "@/components";
import { CellStatus } from "@/lib/api";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePipelines, type RunCellView, type RunView } from "@/state/pipelines";
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

/** Items down, steps across; a click on a cell opens its details. */
export function RunGrid({ run }: { run: RunView }) {
  const catalog = usePipelines((s) => s.catalog);
  const modules = useModules((s) => s.byId);
  const byId = useJobs((s) => s.byId);
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const items = useMemo(() => orderItems(run.items), [run.items]);

  const toolName = (type: string) => modules[type]?.name ?? catalog.find((t) => t.id === type)?.name ?? type;
  const toolIcon = (type: string) => catalog.find((t) => t.id === type)?.icon ?? modules[type]?.icon ?? "box";
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
              <th key={s.id} scope="col" className={styles.stepHead} data-tip={`Step ${i + 1}: ${stepName(s, toolName(s.type))}`}>
                <Icon name={toolIcon(s.type)} size={14} />
                <span className={styles.stepNo}>{i + 1}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const merged = isMergedItem(item);
            return (
              <tr key={item.index} className={cx(merged && styles.mergedRow)}>
                <th scope="row" className={styles.rowHead} data-tip={merged ? `${item.label} (several files combined into one)` : item.label}>
                  {merged && <Icon name="merge" size={12} className={styles.mergeIcon} />}
                  <span className={styles.rowLabel}>{item.label}</span>
                </th>
                {run.steps.map((s, i) => {
                  const cell = item.cells[i];
                  if (!cell) return <td key={s.id} />;
                  const look = cellLook(cell);
                  const p = cellProgress(cell, byId);
                  const name = stepName(s, toolName(s.type));
                  return (
                    <td key={s.id} className={styles.cellTd}>
                      <button
                        type="button"
                        className={cx(styles.cell, styles[look.tone], open?.item === item.index && open.step === i && styles.selected)}
                        data-status={cell.status}
                        aria-label={`${name}, ${item.label}: ${look.label}`}
                        data-tip={`${look.label}. Click for details, files and logs`}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setOpen({ item: item.index, step: i, left: r.left, bottom: r.bottom });
                        }}
                      >
                        <Icon name={look.icon} size={16} className={cx(look.spin && styles.spin)} />
                        {p >= 0 && <span className={styles.pct}>{Math.round(p * 100)}%</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && openItem && <CellPopover run={run} item={openItem} stepIndex={open.step} anchor={open} onClose={close} />}
    </div>
  );
}
