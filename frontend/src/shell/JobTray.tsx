import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "@/lib/errors";
import { Button, Icon, IconButton, Kbd, Meter, toast, cx, type MeterStatus } from "@/components";
import { JobStatus } from "@/lib/api";
import { useJobs, useJobCounts, useOrderedJobs } from "@/state/jobs";
import { useUI } from "@/state/ui";
import { JobRow } from "./JobRow";
import styles from "./JobTray.module.css";

export const STRIP_HEIGHT = 36;
const MIN_HEIGHT = 200;

function clampHeight(px: number): number {
  const max = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.6));
  return Math.min(max, Math.max(MIN_HEIGHT, px));
}

export function JobTray() {
  const open = useUI((s) => s.trayOpen);
  const height = useUI((s) => s.trayHeight);
  const setOpen = useUI((s) => s.setTrayOpen);
  const setHeight = useUI((s) => s.setTrayHeight);
  const counts = useJobCounts();
  const jobs = useOrderedJobs();
  const byId = useJobs((s) => s.byId);
  const [resizing, setResizing] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  const aggregate = useMemo(() => {
    const running = Object.values(byId).filter((j) => j.status === JobStatus.JobRunning);
    if (running.length === 0) return { value: 0, status: "queued" as MeterStatus };
    if (running.some((j) => j.progress < 0)) return { value: -1, status: "running" as MeterStatus };
    const mean = running.reduce((a, j) => a + j.progress, 0) / running.length;
    return { value: mean, status: "running" as MeterStatus };
  }, [byId]);

  const idle = counts.running === 0 && counts.queued === 0;
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (idle) parts.push(counts.done > 0 ? `${counts.done} done` : "Idle");
  const summary = parts.join(" · ");

  const effective = clampHeight(height);
  const px = open ? effective : STRIP_HEIGHT;

  // Keep the toaster above the tray.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--toaster-bottom", `${px + 16}px`);
  }, [px]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setResizing(true);
      const startY = e.clientY;
      const startH = effective;
      const move = (ev: PointerEvent) => setHeight(clampHeight(startH + (startY - ev.clientY)));
      const up = () => {
        setResizing(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [effective, setHeight],
  );

  const clear = () => {
    useJobs
      .getState()
      .clearFinished()
      .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
  };

  return (
    <section
      ref={rootRef}
      className={cx(styles.tray, resizing && styles.resizing)}
      style={{ height: px }}
      aria-label="Job tray"
    >
      {open && <div className={styles.handle} onPointerDown={startResize} role="separator" aria-orientation="horizontal" />}
      <button
        type="button"
        className={styles.strip}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Toggle job tray"
      >
        <Meter className={styles.meter} value={aggregate.value} status={aggregate.status} size="sm" label="Overall progress" />
        <span className={styles.summary}>{summary}</span>
        {counts.failed > 0 && <span className={cx(styles.summary, styles.failed)}>{counts.failed} failed</span>}
        <span className={styles.spacer} />
        <Kbd combo="Mod+J" />
        <span className={styles.chev}>
          <Icon name={open ? "chevron-down" : "chevron-up"} size={14} />
        </span>
      </button>
      {open && (
        <>
          <div className={styles.header}>
            <span>
              {counts.total} {counts.total === 1 ? "job" : "jobs"}
            </span>
            <span className={styles.spacer} />
            <Button size="sm" variant="ghost" onClick={clear} disabled={counts.done + counts.failed + counts.cancelled === 0}>
              Clear finished
            </Button>
            <IconButton size="sm" icon="chevron-down" label="Collapse" onClick={() => setOpen(false)} />
          </div>
          <div className={styles.list}>
            {jobs.length === 0 ? (
              <div className={styles.empty}>No jobs yet. Paste a link anywhere to start a download.</div>
            ) : (
              jobs.map((j) => <JobRow key={j.id} job={j} />)
            )}
          </div>
        </>
      )}
    </section>
  );
}
