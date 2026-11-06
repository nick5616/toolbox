import { Icon, IconButton, cx } from "@/components";
import { CellStatus } from "@/lib/api";
import { useModules } from "@/state/modules";
import { usePipelines, type RunView } from "@/state/pipelines";
import type { PipelineStep } from "@/lib/api";
import { NeedsYouCard } from "./NeedsYouCard";
import { cellLook, stepName } from "./RunGridModel";
import { isNeedsYou, stepCells } from "./RunGraphModel";
import { RunFileRow } from "./RunResultsFileRow";
import { isTimeWait } from "./timeWait";
import { TimeWaitCard } from "./TimeWaitCard";
import styles from "./RunGraph.module.css";

/** The cells of one step, per item: status, error, and the files as draggable rows with Send to. A waiting step shows its Continue / Skip card. */
export function RunGraphPanel({ run, step, onClose }: { run: RunView; step: PipelineStep; onClose: () => void }) {
  const catalogName = usePipelines((s) => s.catalog.find((t) => t.id === step.type)?.name);
  const toolName = useModules((s) => catalogName ?? s.byId[step.type]?.name ?? step.type);
  const rows = stepCells(run, step.id);
  const title = stepName(step, toolName);
  return (
    <aside
      className={styles.panel}
      role="complementary"
      aria-label={`${title}: files and progress`}
      data-no-wheel="1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        <IconButton size="sm" icon="x" label="Close step details" onClick={onClose} />
      </header>
      <div className={styles.panelBody}>
        {rows.length === 0 && <div className={styles.none}>Nothing has reached this step yet.</div>}
        {rows.map(({ item, cell, stepIndex }) => {
          const look = cellLook(cell);
          const failed = cell.status === CellStatus.CellFailed;
          if (isNeedsYou(cell)) {
            return <NeedsYouCard key={item.index} w={{ run, item, cell, step, stepIndex, kind: cell.wait }} />;
          }
          if (isTimeWait(cell)) return <TimeWaitCard key={item.index} run={run} item={item} cell={cell} />;
          return (
            <section key={item.index} className={styles.cellRow} aria-label={`${item.label}: ${look.label}`}>
              <div className={styles.cellHead}>
                <Icon name={look.icon} size={14} className={cx(styles.cellIcon, styles[look.tone], look.spin && styles.spin)} />
                <span className={styles.cellItem} title={item.label}>{item.label}</span>
                <span className={styles.cellState}>{look.label}</span>
              </div>
              {failed && cell.error ? (
                <div className={styles.cellError}>
                  <div>{cell.error}</div>
                  {cell.errorHint && <div className={styles.cellHint}>{cell.errorHint}</div>}
                </div>
              ) : (
                cell.message && <div className={styles.cellMsg}>{cell.message}</div>
              )}
              {cell.files.map((f) => (
                <RunFileRow key={f.path} file={f} />
              ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
