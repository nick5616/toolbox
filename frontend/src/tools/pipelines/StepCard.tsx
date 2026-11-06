import { useMemo, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { Badge, Icon, IconButton, cx } from "@/components";
import type { PipelineStep, StepCheck, StepType } from "@/lib/api";
import { FROM_INPUT, FROM_NONE } from "@/pipelines/compat";
import { filterOf } from "./editorModel";
import { roleProducts, filterText, stepName } from "./stepHelpers";
import { StepOptions } from "./StepOptions";
import styles from "./StepCard.module.css";

export interface StepCardProps {
  index: number;
  step: PipelineStep;
  /** Every step of the pipeline, in order (the From select lists the earlier ones). */
  steps: readonly PipelineStep[];
  catalog: readonly StepType[];
  /** Describe's answers by step ID. */
  checkById: ReadonlyMap<string, StepCheck>;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<PipelineStep>) => void;
  /** The user switched Keep themselves (so adding a step won't undo it). */
  onKeepTouched: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  onHandlePointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  /** Being dragged right now. */
  dragging?: boolean;
  cardRef?: Ref<HTMLElement>;
}

/** One step of the pipeline: collapsed summary and expanded editor (SPEC.md §11.4). */
export function StepCard({
  index,
  step,
  steps,
  catalog,
  checkById,
  expanded,
  onToggle,
  onChange,
  onKeepTouched,
  onDuplicate,
  onRemove,
  onMove,
  onHandlePointerDown,
  dragging,
  cardRef,
}: StepCardProps) {
  const type = useMemo(() => catalog.find((t) => t.id === step.type), [catalog, step.type]);
  const filter = useMemo(() => filterOf(step.filter), [step.filter]);
  const check = checkById.get(step.id);
  const problems = check?.problems ?? [];
  const name = stepName(step, type);
  const isLast = index === steps.length - 1;

  const fromIndex = steps.findIndex((s) => s.id === step.from);
  const source = fromIndex >= 0 ? steps[fromIndex] : undefined;
  const sourceProducts = source ? (checkById.get(source.id)?.info.produces ?? []) : [];
  const roles = roleProducts(sourceProducts);

  const summary = check?.info.summary ?? "";
  const filterLabel = filterText(filter, roles);
  const fromLabel = step.from === FROM_NONE ? "no files" : step.from === FROM_INPUT ? "the files you run it on" : `step ${fromIndex + 1}`;
  const showFromChip = filterLabel !== "" || (step.from === FROM_INPUT ? index > 0 : step.from === FROM_NONE ? true : fromIndex !== index - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      onMove(e.key === "ArrowUp" ? -1 : 1);
    }
  };

  const bodyId = `step-${step.id}-body`;

  return (
    <section
      ref={cardRef}
      className={cx(styles.card, expanded && styles.expanded, problems.length > 0 && styles.hasProblems, dragging && styles.dragging)}
      aria-label={`Step ${index + 1}: ${name}`}
      data-step-id={step.id}
      onKeyDown={onKeyDown}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.handle}
          aria-label={`Move step ${index + 1} (Alt+Up or Alt+Down)`}
          data-tip="Drag to reorder this step, or press Alt+Up / Alt+Down"
          data-step-handle={step.id}
          onPointerDown={onHandlePointerDown}
        >
          <Icon name="grip-vertical" size={14} />
        </button>
        <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={bodyId} data-tip={expanded ? "Collapse this step" : "Show this step's options"} onClick={onToggle}>
          <span className={styles.number} data-tip="Position in the pipeline; steps run from top to bottom">{index + 1}</span>
          <Icon name={type?.icon ?? "box"} size={16} className={styles.icon} />
          <span className={styles.name}>{name}</span>
          <span className={styles.summary} data-tip={step.manual ? undefined : "What this step will do with its current settings"}>{step.manual ? "" : summary}</span>
          <span className={styles.chips}>
            {showFromChip && (
              <Badge tip="Where this step gets its files, and which ones it takes">
                from {fromLabel}
                {filterLabel ? ` · ${filterLabel}` : ""}
              </Badge>
            )}
            {step.manual && <Badge tone="accent" tip="The pipeline pauses here and waits for you to do this step in the tool">I&apos;ll do this myself</Badge>}
            <Badge tone={step.keep ? "ok" : "neutral"} tip={step.keep ? "Its files stay in your Library after the run" : "Its files are temporary and are deleted when the run finishes cleanly"}>{step.keep ? "Kept" : "In-between"}</Badge>
            {problems.length > 0 && (
              <Badge tone="danger" tip="This step has problems that stop the pipeline; expand it to read them">
                <span aria-hidden="true">⚠ </span>
                {problems.length}
                <span className={styles.srOnly}> {problems.length === 1 ? "problem" : "problems"}</span>
              </Badge>
            )}
          </span>
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className={styles.chevron} />
        </button>
        <span className={styles.moves}>
          <IconButton size="sm" icon="arrow-up" label={`Move step ${index + 1} up`} data-tip={index === 0 ? "This is already the first step" : "Run this step earlier"} disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton size="sm" icon="arrow-down" label={`Move step ${index + 1} down`} data-tip={isLast ? "This is already the last step" : "Run this step later"} disabled={isLast} onClick={() => onMove(1)} />
        </span>
      </div>

      {problems.length > 0 && (
        <ul className={styles.problems} aria-label={`Problems in step ${index + 1}`}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {expanded && (
        <StepOptions
          id={bodyId}
          step={step}
          steps={steps}
          index={index}
          catalog={catalog}
          checkById={checkById}
          onChange={onChange}
          onKeepTouched={onKeepTouched}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
      )}
    </section>
  );
}
