import { useEffect, useRef } from "react";
import { Button, StatusChip, type ChipStatus } from "@/components";
import { CellStatus } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import type { RunItemView, RunView } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { cellLook, stepName } from "./RunGridModel";
import { RunFileRow } from "./RunResultsFileRow";
import styles from "./CellPopover.module.css";

export interface CellPopoverProps {
  run: RunView;
  item: RunItemView;
  stepIndex: number;
  /** Where the clicked cell is, in viewport coordinates. */
  anchor: { left: number; bottom: number };
  onClose: () => void;
}

const WIDTH = 340;

/** Details of one grid cell: message or error, jobs, files and variables. */
export function CellPopover({ run, item, stepIndex, anchor, onClose }: CellPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const byId = useJobs((s) => s.byId);
  const toolName = useModules((s) => s.byId[run.steps[stepIndex]?.type ?? ""]?.name ?? run.steps[stepIndex]?.type ?? "");
  const step = run.steps[stepIndex];
  const cell = item.cells[stepIndex];

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  if (!step || !cell) return null;
  const look = cellLook(cell);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
  const vars = Object.entries(item.vars);

  const showLog = (id: string) => {
    useUI.getState().setTrayOpen(true);
    useUI.getState().setExpandedLogJobId(id);
  };

  const failed = cell.status === CellStatus.CellFailed;

  return (
    <div
      ref={ref}
      className={styles.pop}
      role="dialog"
      aria-label={`${stepName(step, toolName)}: ${item.label}`}
      tabIndex={-1}
      style={{ left, top: anchor.bottom + 4, width: WIDTH }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.title}>{stepName(step, toolName)}</div>
      <div className={styles.sub}>
        {item.label} · {look.label}
      </div>
      {failed && cell.error ? (
        <div className={styles.error}>
          <div>{cell.error}</div>
          {cell.errorHint && <div className={styles.hint}>{cell.errorHint}</div>}
        </div>
      ) : (
        cell.message && <div className={styles.message}>{cell.message}</div>
      )}

      {cell.jobIds.length > 0 && (
        <div className={styles.section}>
          <div className={styles.label} data-tip="The tool jobs that ran for this step">Jobs</div>
          <ul className={styles.list}>
            {cell.jobIds.map((id) => {
              const job = byId[id];
              return (
                <li key={id} className={styles.job}>
                  <span className={styles.jobTitle}>{job ? job.title || job.id : id}</span>
                  {job && <StatusChip status={job.status as ChipStatus} />}
                  <Button size="sm" variant="ghost" onClick={() => showLog(id)} aria-label={`Show log for ${job?.title || id}`} data-tip="Open the job tray with this job's technical output">
                    Show log
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {cell.files.length > 0 && (
        <div className={styles.section}>
          <div className={styles.label} data-tip="Files this step made">Files</div>
          <ul className={styles.list}>
            {cell.files.map((f) => (
              <RunFileRow key={f.path} file={f} />
            ))}
          </ul>
        </div>
      )}

      {vars.length > 0 && (
        <div className={styles.section}>
          <div className={styles.label} data-tip="Values later steps can use as {name} in their text options">Variables</div>
          <dl className={styles.vars}>
            {vars.map(([k, v]) => (
              <div key={k} className={styles.var}>
                <dt>{k}</dt>
                <dd data-tip={v}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
