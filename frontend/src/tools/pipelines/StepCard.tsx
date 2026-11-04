import { useMemo, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { Badge, Button, Field, Icon, IconButton, SegmentedControl, Select, Switch, TextField, cx } from "@/components";
import type { PipelineStep, StepCheck, StepProduct, StepType } from "@/lib/api";
import { FROM_INPUT, FROM_NONE } from "@/pipelines/compat";
import { stepUI } from "@/pipelines/steps";
import { BUILTIN_VARS } from "@/pipelines/vars";
import { autoContinueFor, CHECK_TYPE, filterOf, isFilterEmpty, NO_FILES_TYPES, type Filter } from "./editorModel";
import { FiltersPopover } from "./FiltersPopover";
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

/** "Step 2 · Stem Splitter" etc. */
function stepName(step: PipelineStep, type: StepType | undefined): string {
  return step.label.trim() || type?.name || step.type;
}

/** Roles a source step makes (deduplicated, with labels). */
function roleProducts(products: readonly StepProduct[]): Array<{ role: string; label: string }> {
  const out: Array<{ role: string; label: string }> = [];
  for (const p of products) if (p.role && !out.some((o) => o.role === p.role)) out.push({ role: p.role, label: p.label || p.role });
  return out;
}

function filterText(f: Filter, roles: ReadonlyArray<{ role: string; label: string }>): string {
  const parts: string[] = [];
  if (f.roles.length > 0) parts.push(f.roles.map((r) => roles.find((x) => x.role === r)?.label ?? r).join(", "));
  if (f.kinds.length > 0) parts.push(f.kinds.join(", "));
  if (f.exts.length > 0) parts.push(f.exts.join(", "));
  const base = parts.length > 0 ? `${parts.join(" · ")} only` : "";
  if (f.name.trim()) return [base, `name has “${f.name.trim()}”`].filter(Boolean).join(" · ");
  return base;
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
  const toolName = type?.name ?? step.type;
  const isCheck = step.type === CHECK_TYPE;
  const noFiles = NO_FILES_TYPES.has(step.type) || check?.info.noFiles === true;
  const canBoth = !!type && type.auto && type.manual;
  const manualOnly = !!type && !type.auto && type.manual;
  const isLast = index === steps.length - 1;

  const fromIndex = steps.findIndex((s) => s.id === step.from);
  const source = fromIndex >= 0 ? steps[fromIndex] : undefined;
  const sourceProducts = source ? (checkById.get(source.id)?.info.produces ?? []) : [];
  const roles = roleProducts(sourceProducts);
  // Selected roles the source doesn't (or no longer) make stay visible so they can be unselected.
  const roleChips = [...roles, ...filter.roles.filter((r) => !roles.some((x) => x.role === r)).map((r) => ({ role: r, label: r }))];

  const summary = check?.info.summary ?? "";
  const filterLabel = filterText(filter, roles);
  const fromLabel = step.from === FROM_NONE ? "no files" : step.from === FROM_INPUT ? "the files you run it on" : `step ${fromIndex + 1}`;
  const showFromChip = filterLabel !== "" || (step.from === FROM_INPUT ? index > 0 : step.from === FROM_NONE ? true : fromIndex !== index - 1);

  const ui = !step.manual && !isCheck ? stepUI(step.type) : undefined;
  const value = useMemo(() => ui?.parse(step.optionsJson), [ui, step.optionsJson]);

  const fromOptions = [
    { value: FROM_INPUT, label: "The files you run it on" },
    ...steps.slice(0, index).map((s, i) => ({ value: s.id, label: `Step ${i + 1} · ${stepName(s, catalog.find((t) => t.id === s.type))}` })),
    ...(noFiles || step.from === FROM_NONE ? [{ value: FROM_NONE, label: "No files" }] : []),
  ];

  const toggleRole = (role: string) => {
    const roles2 = filter.roles.includes(role) ? filter.roles.filter((r) => r !== role) : [...filter.roles, role];
    onChange({ filter: { ...filter, roles: roles2 } });
  };

  const setManual = (manual: boolean) => {
    onChange(manual ? { manual, autoContinue: autoContinueFor(step.type) } : { manual });
  };

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
        <div id={bodyId} className={styles.body}>
          <div className={styles.row}>
            <Field label="Files from" className={styles.grow}>
              {(c) => (
                <Select
                  {...c}
                  data-tip="Which files this step works on: the ones you start the run with, or what an earlier step made"
                  size="sm"
                  value={step.from}
                  options={fromOptions}
                  onChange={(from) => onChange({ from, filter: from === step.from ? filter : { ...filter, roles: [] } })}
                />
              )}
            </Field>
          </div>

          {step.from !== FROM_NONE && (
            <div className={styles.only}>
              <span className={styles.onlyLabel} data-tip="Limit this step to certain kinds of files from its source">Only</span>
              {roleChips.map((r) => (
                <button
                  key={r.role}
                  type="button"
                  className={cx(styles.chip, filter.roles.includes(r.role) && styles.chipOn)}
                  aria-pressed={filter.roles.includes(r.role)}
                  data-tip={filter.roles.includes(r.role) ? `Stop limiting to ${r.label}` : `Only take the "${r.label}" files from the source step`}
                  onClick={() => toggleRole(r.role)}
                >
                  {r.label}
                </button>
              ))}
              {roleChips.length === 0 && isFilterEmpty(filter) && <span className={styles.muted} data-tip="No filter: this step takes all files from its source">everything it gets</span>}
              <FiltersPopover filter={filter} onChange={(filter) => onChange({ filter })} />
            </div>
          )}

          {isCheck ? (
            <>
              <p className={styles.help}>The pipeline pauses here until you choose which files to carry on.</p>
              <Field label="Note">
                {(c) => (
                  <TextField
                    {...c}
                    size="sm"
                    maxLength={200}
                    value={step.note}
                    placeholder="What should you look for?"
                    data-tip="A reminder shown when the pipeline pauses, e.g. what to check"
                    onChange={(e) => onChange({ note: e.target.value })}
                  />
                )}
              </Field>
            </>
          ) : (
            <>
              {canBoth && (
                <div className={styles.how}>
                  <SegmentedControl
                    size="sm"
                    aria-label="How"
                    value={step.manual ? "manual" : "auto"}
                    onChange={(v) => setManual(v === "manual")}
                    options={[
                      { value: "auto", label: "Automatically", tip: "Toolbox runs this step for you with the options below" },
                      { value: "manual", label: `I'll do it myself in ${toolName}`, tip: `The pipeline pauses and opens ${toolName} with the files; you set it up and run it` },
                    ]}
                  />
                </div>
              )}
              {step.manual || manualOnly ? (
                <>
                  <p className={styles.help}>{toolName} opens with the file loaded and uses its own settings.</p>
                  <Switch
                    checked={step.autoContinue}
                    onChange={(autoContinue) => onChange({ autoContinue })}
                    label={`Continue when ${toolName} finishes`}
                    tip={`Carry on automatically once your ${toolName} job is done, instead of waiting for you to press Continue`}
                  />
                  <Field label="Note">
                    {(c) => (
                      <TextField
                        {...c}
                        size="sm"
                        maxLength={200}
                        value={step.note}
                        placeholder="Shown on the “needs you” card"
                        data-tip="A reminder shown on the waiting card, e.g. what settings to use"
                        onChange={(e) => onChange({ note: e.target.value })}
                      />
                    )}
                  </Field>
                </>
              ) : ui && value !== undefined ? (
                <div className={styles.editor}>
                  <ui.Editor
                    value={value}
                    onChange={(next) => onChange({ optionsJson: JSON.stringify(next) })}
                    check={check}
                    vars={check?.vars ?? [...BUILTIN_VARS]}
                  />
                </div>
              ) : (
                <div className={styles.unknown}>
                  <strong>This step can&apos;t be edited here</strong>
                  {summary && <span>{summary}</span>}
                </div>
              )}
            </>
          )}

          {(check?.info.warnings ?? []).map((w) => (
            <p key={w} className={styles.warning}>
              {w}
            </p>
          ))}

          <div className={styles.keep}>
            <Switch
              checked={step.keep}
              onChange={(keep) => {
                onKeepTouched();
                onChange({ keep });
              }}
              label="Keep its files in the Library"
              tip="On: this step's results stay in your Library. Off: they are temporary and deleted after a clean run"
            />
            <p className={styles.help}>Off: deleted when the run finishes without problems.</p>
          </div>

          <div className={styles.footer}>
            <Field label="Label" className={styles.grow}>
              {(c) => (
                <TextField
                  {...c}
                  size="sm"
                  maxLength={60}
                  value={step.label}
                  placeholder={toolName}
                  data-tip="A custom name for this step in the list and in run results"
                  onChange={(e) => onChange({ label: e.target.value })}
                />
              )}
            </Field>
            <Button size="sm" variant="secondary" icon="copy" data-tip="Add a copy of this step right after it, with the same options" onClick={onDuplicate}>
              Duplicate
            </Button>
            <Button size="sm" variant="danger" icon="trash-2" data-tip="Take this step out of the pipeline" onClick={onRemove}>
              Remove
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
