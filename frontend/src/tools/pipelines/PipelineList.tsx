import { useEffect } from "react";
import { Button, EmptyState, Icon, IconButton, cx } from "@/components";
import { PipelinesService, type PipelineEntry, type StepType } from "@/lib/api";
import { describeAccepts } from "@/pipelines/compat";
import { usePipelines } from "@/state/pipelines";
import { createPipeline } from "./createPipeline";
import { runWithoutFiles, startsWithoutFiles } from "./runNoFiles";
import { scheduleLine } from "./scheduleModel";
import styles from "./PipelineList.module.css";

// The pipeline list (SPEC.md §11.2). Props frozen (Wave 0).
export interface PipelineListProps {
  /** Opens the template gallery. */
  onNew: () => void;
}

/** The templates the empty state offers directly. */
const QUICK_TEMPLATES = ["social-clip", "podcast", "sampling", "product-photos"];

export type PipelineStatus = "ready" | "problems" | "missing";

export function pipelineStatus(e: PipelineEntry): PipelineStatus {
  if (e.check.ready) return "ready";
  if ((e.check.missing ?? []).length > 0) return "missing";
  return "problems";
}

const STATUS_LABEL: Record<PipelineStatus, string> = {
  ready: "Ready",
  problems: "Has problems",
  missing: "Tools missing",
};

function stepIcon(catalog: readonly StepType[], type: string): string {
  return catalog.find((t) => t.id === type)?.icon ?? "box";
}

/** Loads the pipelines and keeps one selected whenever there is one (also used while the list is hidden). */
export function usePipelineListEffects(): void {
  const entries = usePipelines((s) => s.entries);
  const loaded = usePipelines((s) => s.loaded);
  const selected = usePipelines((s) => s.selectedPipelineId);
  const selectPipeline = usePipelines((s) => s.selectPipeline);
  useEffect(() => {
    if (!loaded) void usePipelines.getState().load().catch(() => undefined);
  }, [loaded]);
  useEffect(() => {
    if (entries.length > 0 && !entries.some((e) => e.pipeline.id === selected)) selectPipeline(entries[0]?.pipeline.id ?? null);
    else if (entries.length === 0 && selected !== null) selectPipeline(null);
  }, [entries, selected, selectPipeline]);
}

export function PipelineList({ onNew }: PipelineListProps) {
  const entries = usePipelines((s) => s.entries);
  const catalog = usePipelines((s) => s.catalog);
  const templates = usePipelines((s) => s.templates);
  const selected = usePipelines((s) => s.selectedPipelineId);
  const selectPipeline = usePipelines((s) => s.selectPipeline);
  const openRunSheet = usePipelines((s) => s.openRunSheet);

  usePipelineListEffects();

  // The runner doesn't announce a next-fire time that simply passes, so refetch the list once a minute while a schedule is on
  // and the window is showing; coming back to the window refetches at once.
  const scheduled = entries.some((e) => e.pipeline.schedule?.enabled === true);
  useEffect(() => {
    if (!scheduled) return;
    const refetch = () => {
      if (document.hidden) return;
      PipelinesService.List()
        .then((list) => usePipelines.getState().setEntries(list ?? []))
        .catch(() => undefined);
    };
    const id = setInterval(refetch, 60_000);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [scheduled]);

  if (entries.length === 0) {
    const quick = QUICK_TEMPLATES.map((id) => templates.find((t) => t.id === id)).filter((t) => t !== undefined);
    return (
      <div className={styles.root}>
        <EmptyState
          icon="workflow"
          title="No pipelines yet"
          body="A pipeline chains tools together and runs them on every file you give it."
          action={
            <Button variant="primary" icon="plus" data-tip="Pick a template or start with an empty pipeline" onClick={onNew}>
              New pipeline
            </Button>
          }
        />
        {quick.length > 0 && (
          <div className={styles.quick}>
            {quick.map((t) => (
              <button key={t.id} type="button" className={styles.quickCard} data-tip={`Create a "${t.pipeline.name}" pipeline from this template`} onClick={() => void createPipeline(t.id)}>
                <Icon name={t.icon} size={16} className={styles.quickIcon} />
                <span className={styles.quickText}>
                  <span className={styles.name}>{t.pipeline.name}</span>
                  <span className={styles.muted}>{t.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <Button variant="ghost" size="sm" data-tip="Browse every ready-made pipeline template" onClick={onNew}>
          All templates…
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <ul className={styles.list} aria-label="Pipelines">
        {entries.map((e) => {
          const p = e.pipeline;
          const status = pipelineStatus(e);
          const watching = p.watch.enabled;
          const noFiles = startsWithoutFiles(e);
          const schedule = scheduleLine(p.schedule?.enabled === true, e.schedule);
          return (
            <li
              key={p.id}
              id={`pipeline-drop:${p.id}`}
              data-file-drop-target={noFiles ? undefined : ""}
              className={cx(styles.card, p.id === selected && styles.selected)}
            >
              <button
                type="button"
                className={styles.main}
                aria-current={p.id === selected ? "true" : undefined}
                aria-label={p.name}
                data-tip={noFiles ? "Select to edit this pipeline" : "Select to edit this pipeline. Drop files on the card to run it"}
                onClick={() => selectPipeline(p.id)}
              >
                <span className={styles.top}>
                  <span
                    className={cx(styles.dot, styles[status])}
                    role="img"
                    aria-label={STATUS_LABEL[status]}
                    data-tip={status === "ready" ? "Ready to run" : status === "missing" ? "Some tools this pipeline uses are not installed" : "A step has a problem; open the pipeline to see it"}
                  />
                  <span className={styles.name}>{p.name}</span>
                </span>
                <span className={styles.icons} aria-hidden="true" data-tip="The tools used by each step, in order">
                  {(p.steps ?? []).map((s) => (
                    <Icon key={s.id} name={stepIcon(catalog, s.type)} size={14} />
                  ))}
                </span>
                <span className={styles.meta}>
                  <span data-tip={noFiles ? "This pipeline starts without files: press Run" : "The kinds of files this pipeline can start with"}>
                    {noFiles ? "Takes no files" : `Takes: ${describeAccepts(e.check.accepts)}`}
                  </span>
                  {schedule && (
                    <span className={styles.watch} data-tip={e.schedule?.message ? "Why the schedule can't run right now" : "When this pipeline runs by itself while Toolbox is open"}>
                      <Icon name="calendar-clock" size={12} />
                      {schedule}
                    </span>
                  )}
                  {watching && (
                    <span className={styles.watch} data-tip={e.watch.message || (e.watch.active ? "Runs automatically on new files in the watched folder" : "Folder watching is paused or not working")}>
                      <Icon name="eye" size={12} />
                      {e.watch.active ? "watching" : "watch paused"}
                    </span>
                  )}
                </span>
              </button>
              <IconButton
                icon="play"
                label={`Run ${p.name}`}
                data-tip={e.check.ready ? (noFiles ? "Run this pipeline now" : "Run this pipeline on files or links you choose") : "Fix this pipeline's problems before running it"}
                variant="ghost"
                size="sm"
                className={styles.run}
                disabled={!e.check.ready}
                onClick={() => (noFiles ? void runWithoutFiles(e) : openRunSheet(p.id))}
              />
            </li>
          );
        })}
      </ul>
      <p className={styles.hint}>{entries.some((e) => !startsWithoutFiles(e)) ? "Drop files on a card to run it, or press its play button." : "Press a card's play button to run it."}</p>
    </div>
  );
}
