import { useEffect, useState } from "react";
import { Button, Icon, toast } from "@/components";
import { PipelinesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { RunCellView, RunItemView, RunView } from "@/state/pipelines";
import { timeWaitText } from "./timeWait";
import styles from "./TimeWaitCard.module.css";

/** Re-renders every `ms` with the current time (a countdown). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Skips the wait of one cell (the step carries on at once). */
export function continueNow(runId: string, item: number, stepId: string): Promise<void> {
  return PipelinesService.Continue({ runId, item, stepId, keep: null, passThrough: false }).catch((e: unknown) => {
    toast({ title: "Couldn't continue", description: toAppError(e).message, tone: "danger" });
  });
}

/** The countdown line and the Continue now button of a time-waiting cell. */
export function TimeWaitCard({ run, item, cell }: { run: RunView; item: RunItemView; cell: RunCellView }) {
  const now = useNow();
  return (
    <section className={styles.card} aria-label={`${item.label}: waiting`}>
      <div className={styles.head}>
        <Icon name="timer" size={14} className={styles.icon} />
        <span className={styles.item} title={item.label}>
          {item.label}
        </span>
        <span className={styles.until} role="timer" data-testid="time-wait">
          {timeWaitText(cell.until, now)}
        </span>
      </div>
      {cell.message && <div className={styles.msg}>{cell.message}</div>}
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" icon="skip-forward" data-tip="Stop waiting and run the next step now" onClick={() => void continueNow(run.id, item.index, cell.stepId)}>
          Continue now
        </Button>
      </div>
    </section>
  );
}
