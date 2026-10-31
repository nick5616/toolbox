import { useEffect } from "react";
import { Button, EmptyState, Icon, IconButton, cx } from "@/components";
import type { PipelineEntry, StepType } from "@/lib/api";
import { describeAccepts } from "@/pipelines/compat";
import { usePipelines } from "@/state/pipelines";
import { createPipeline } from "./createPipeline";
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

export function PipelineList({ onNew }: PipelineListProps) {
  const entries = usePipelines((s) => s.entries);
  const catalog = usePipelines((s) => s.catalog);
  const templates = usePipelines((s) => s.templates);
  const loaded = usePipelines((s) => s.loaded);
  const selected = usePipelines((s) => s.selectedPipelineId);
  const selectPipeline = usePipelines((s) => s.selectPipeline);
  const openRunSheet = usePipelines((s) => s.openRunSheet);

  useEffect(() => {
    if (!loaded) void usePipelines.getState().load().catch(() => undefined);
  }, [loaded]);

  // Keep a pipeline selected whenever there is one.
  useEffect(() => {
    if (entries.length > 0 && !entries.some((e) => e.pipeline.id === selected)) selectPipeline(entries[0]?.pipeline.id ?? null);
    else if (entries.length === 0 && selected !== null) selectPipeline(null);
  }, [entries, selected, selectPipeline]);

  if (entries.length === 0) {
    const quick = QUICK_TEMPLATES.map((id) => templates.find((t) => t.id === id)).filter((t) => t !== undefined);
    return (
      <div className={styles.root}>
        <EmptyState
          icon="workflow"
          title="No pipelines yet"
          body="A pipeline chains tools together and runs them on every file you give it."
          action={
            <Button variant="primary" icon="plus" onClick={onNew}>
              New pipeline
            </Button>
          }
        />
        {quick.length > 0 && (
          <div className={styles.quick}>
            {quick.map((t) => (
              <button key={t.id} type="button" className={styles.quickCard} onClick={() => void createPipeline(t.id)}>
                <Icon name={t.icon} size={16} className={styles.quickIcon} />
                <span className={styles.quickText}>
                  <span className={styles.name}>{t.pipeline.name}</span>
                  <span className={styles.muted}>{t.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={onNew}>
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
          return (
            <li
              key={p.id}
              id={`pipeline-drop:${p.id}`}
              data-file-drop-target=""
              className={cx(styles.card, p.id === selected && styles.selected)}
            >
              <button
                type="button"
                className={styles.main}
                aria-current={p.id === selected ? "true" : undefined}
                aria-label={p.name}
                onClick={() => selectPipeline(p.id)}
              >
                <span className={styles.top}>
                  <span
                    className={cx(styles.dot, styles[status])}
                    role="img"
                    aria-label={STATUS_LABEL[status]}
                    title={STATUS_LABEL[status]}
                  />
                  <span className={styles.name}>{p.name}</span>
                </span>
                <span className={styles.icons} aria-hidden="true">
                  {(p.steps ?? []).map((s) => (
                    <Icon key={s.id} name={stepIcon(catalog, s.type)} size={14} />
                  ))}
                </span>
                <span className={styles.meta}>
                  <span>Takes: {describeAccepts(e.check.accepts)}</span>
                  {watching && (
                    <span className={styles.watch} title={e.watch.message || "Watching a folder"}>
                      <Icon name="eye" size={12} />
                      {e.watch.active ? "watching" : "watch paused"}
                    </span>
                  )}
                </span>
              </button>
              <IconButton
                icon="play"
                label={`Run ${p.name}`}
                variant="ghost"
                size="sm"
                className={styles.run}
                disabled={!e.check.ready}
                onClick={() => openRunSheet(p.id)}
              />
            </li>
          );
        })}
      </ul>
      <p className={styles.hint}>Drop files on a card to run it.</p>
    </div>
  );
}
