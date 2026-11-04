import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ConfirmDialog, EmptyState, Select, StatusChip, cx, toast } from "@/components";
import { PipelinesService, RunStatus } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { isRunActive, usePipelines, useRunList, waitingCells, type RunView } from "@/state/pipelines";
import { NeedsYouCard } from "./NeedsYouCard";
import { RunGrid } from "./RunGrid";
import { hasTemporaryFiles, runChip, runProgress, sortRuns } from "./RunGridModel";
import { RunResults } from "./RunResults";
import styles from "./RunsPanel.module.css";

function report(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

const TRIGGER: Record<string, string> = { manual: "Started by you", watch: "Started by a watched folder" };

function RunRow({ run, selected, onSelect }: { run: RunView; selected: boolean; onSelect: () => void }) {
  const chip = runChip(run.status);
  const { done, total } = runProgress(run);
  return (
    <li>
      <button type="button" className={cx(styles.row, selected && styles.selected)} aria-current={selected ? "true" : undefined} data-tip="Show this run's progress and results" onClick={onSelect}>
        <span className={styles.rowTop}>
          <span className={styles.rowName}>{run.name}</span>
          <StatusChip status={chip.status} label={chip.label} />
        </span>
        <span className={styles.rowMeta}>
          <span data-tip="Files that finished all their steps, out of all files in this run">{`${done} of ${total} ${total === 1 ? "file" : "files"}`}</span>
          <span>{formatRelativeTime(run.createdAt)}</span>
          {run.needsYou > 0 && <Badge tone="accent" tip="A step is waiting for you to check or do something">Needs you</Badge>}
        </span>
      </button>
    </li>
  );
}

function RunDetail({ run }: { run: RunView }) {
  const upsertRun = usePipelines((s) => s.upsertRun);
  const removeRuns = usePipelines((s) => s.removeRuns);
  const runs = usePipelines((s) => s.runs);
  const [confirm, setConfirm] = useState(false);
  const [alsoClean, setAlsoClean] = useState(true);
  const active = isRunActive(run);
  const chip = runChip(run.status);
  const waiting = useMemo(() => waitingCells(runs).filter((w) => w.run.id === run.id), [runs, run.id]);
  const retryable = (run.status === RunStatus.RunPartial || run.status === RunStatus.RunFailed || run.status === RunStatus.RunCancelled) && !run.cleaned;
  const cleanable = !active && hasTemporaryFiles(run);

  return (
    <div className={styles.detail}>
      <header className={styles.header}>
        <div className={styles.headTitle}>
          <h2 className={styles.name}>{run.name}</h2>
          <StatusChip status={chip.status} label={chip.label} />
        </div>
        <div className={styles.headMeta} data-tip="When it started and what started it">
          Started {formatRelativeTime(run.createdAt)} · {TRIGGER[run.trigger] ?? run.trigger}
        </div>
        <div className={styles.headActions}>
          {active && (
            <Button size="sm" icon="square" data-tip="Stop this run; steps that already finished keep their files" onClick={() => PipelinesService.Cancel(run.id).catch(report)}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            icon="rotate-ccw"
            disabled={!retryable}
            data-tip={retryable ? "Run again only the files and steps that failed or were cancelled" : "Nothing to retry: no step failed or was cancelled"}
            onClick={() => PipelinesService.Retry(run.id).then(upsertRun).catch(report)}
          >
            Retry failed
          </Button>
          <Button
            size="sm"
            icon="trash-2"
            disabled={!cleanable}
            data-tip={cleanable ? "Delete the temporary files of steps not set to Keep; kept results stay" : active ? "Wait for the run to finish first" : "There are no in-between files to delete"}
            onClick={() =>
              PipelinesService.CleanUp(run.id)
                .then((n) => toast({ tone: "success", title: n === 1 ? "Deleted 1 in-between file" : `Deleted ${n} in-between files` }))
                .catch(report)
            }
          >
            Delete in-between files
          </Button>
          <Button size="sm" variant="danger" icon="x" disabled={active} data-tip={active ? "Cancel the run before removing it" : "Remove this run from the list; kept files stay in your Library"} onClick={() => setConfirm(true)}>
            Remove
          </Button>
        </div>
      </header>

      {run.error && <div className={styles.runError}>{run.error}</div>}

      {waiting.map((w) => (
        <NeedsYouCard key={`${w.item.index}:${w.step.id}`} w={w} />
      ))}

      <RunGrid run={run} />
      <RunResults run={run} />

      <ConfirmDialog
        open={confirm}
        title={`Remove ${run.name}?`}
        tone="danger"
        confirmLabel="Remove"
        body={
          <div className={styles.confirm}>
            <p>This removes the run from the list. The jobs and the files you kept stay.</p>
            <label className={styles.check}>
              <input type="checkbox" data-tip="Also delete files of steps that were not set to Keep" checked={alsoClean} onChange={(e) => setAlsoClean(e.target.checked)} />
              Also delete in-between files
            </label>
          </div>
        }
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          PipelinesService.Remove(run.id, alsoClean)
            .then(() => removeRuns([run.id]))
            .catch(report);
        }}
      />
    </div>
  );
}

/** The Runs tab (SPEC.md §11.5): the list of runs and the selected run. */
export function RunsPanel() {
  const all = useRunList();
  const entries = usePipelines((s) => s.entries);
  const filter = usePipelines((s) => s.runFilter);
  const setFilter = usePipelines((s) => s.setRunFilter);
  const selectedId = usePipelines((s) => s.selectedRunId);
  const showRun = usePipelines((s) => s.showRun);

  const runs = useMemo(() => sortRuns(all.filter((r) => !filter || r.pipelineId === filter)), [all, filter]);
  const options = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) seen.set(e.pipeline.id, e.pipeline.name);
    for (const r of all) if (!seen.has(r.pipelineId)) seen.set(r.pipelineId, r.name);
    return [{ value: "", label: "All pipelines" }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [entries, all]);

  const selected = runs.find((r) => r.id === selectedId);
  const first = runs[0];
  // Select the newest run when none (or a filtered-out one) is selected.
  useEffect(() => {
    if (!selected && first) showRun(first.id);
  }, [selected, first, showRun]);

  if (all.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState icon="workflow" title="No runs yet" body="Run a pipeline on some files and its progress shows up here." />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <aside className={styles.list}>
        <Select aria-label="Filter runs by pipeline" data-tip="Show only the runs of one pipeline" size="sm" value={filter} options={options} onChange={setFilter} />
        {runs.length === 0 ? (
          <div className={styles.none}>No runs of this pipeline.</div>
        ) : (
          <ul className={styles.rows} aria-label="Runs">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} selected={r.id === selected?.id} onSelect={() => showRun(r.id)} />
            ))}
          </ul>
        )}
      </aside>
      <section className={styles.main}>{selected ? <RunDetail key={selected.id} run={selected} /> : null}</section>
    </div>
  );
}
