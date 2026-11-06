import { useMemo } from "react";
import { Button, Field, SegmentedControl, Select, Switch, TextField, cx } from "@/components";
import type { PipelineStep, StepCheck, StepType } from "@/lib/api";
import { FROM_INPUT, FROM_NONE } from "@/pipelines/compat";
import { stepUI } from "@/pipelines/steps";
import { BUILTIN_VARS } from "@/pipelines/vars";
import { autoContinueFor, CHECK_TYPE, filterOf, isFilterEmpty, NO_FILES_TYPES } from "./editorModel";
import { FiltersPopover } from "./FiltersPopover";
import { roleProducts, stepName } from "./stepHelpers";
import styles from "./StepCard.module.css";

export interface StepOptionsProps {
  step: PipelineStep;
  /** Every step of the pipeline in order (the From select lists the ones before `index`). */
  steps: readonly PipelineStep[];
  index: number;
  catalog: readonly StepType[];
  checkById: ReadonlyMap<string, StepCheck>;
  onChange: (patch: Partial<PipelineStep>) => void;
  onKeepTouched: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** The graph view: wires choose the source, so the "Files from" select and role chips are hidden. */
  graph?: boolean;
  id?: string;
}

/** The options of one step: source, filter, how it runs, its tool's own options, Keep and the footer (SPEC.md §11.4). */
export function StepOptions({ step, steps, index, catalog, checkById, onChange, onKeepTouched, onDuplicate, onRemove, graph = false, id }: StepOptionsProps) {
  const type = useMemo(() => catalog.find((t) => t.id === step.type), [catalog, step.type]);
  const filter = useMemo(() => filterOf(step.filter), [step.filter]);
  const check = checkById.get(step.id);
  const toolName = type?.name ?? step.type;
  const isCheck = step.type === CHECK_TYPE;
  const noFiles = NO_FILES_TYPES.has(step.type) || check?.info.noFiles === true;
  const canBoth = !!type && type.auto && type.manual;
  const manualOnly = !!type && !type.auto && type.manual;
  const summary = check?.info.summary ?? "";

  const fromIndex = steps.findIndex((s) => s.id === step.from);
  const source = fromIndex >= 0 ? steps[fromIndex] : undefined;
  const sourceProducts = source ? (checkById.get(source.id)?.info.produces ?? []) : [];
  const roles = roleProducts(sourceProducts);
  // Selected roles the source doesn't (or no longer) make stay visible so they can be unselected.
  const roleChips = [...roles, ...filter.roles.filter((r) => !roles.some((x) => x.role === r)).map((r) => ({ role: r, label: r }))];

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

  return (
    <div id={id} className={styles.body}>
      {!graph && (
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
      )}

      {step.from !== FROM_NONE && (
        <div className={styles.only}>
          <span className={styles.onlyLabel} data-tip="Limit this step to certain kinds of files from its source">Only</span>
          {!graph &&
            roleChips.map((r) => (
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
          {!graph && roleChips.length === 0 && isFilterEmpty(filter) && <span className={styles.muted} data-tip="No filter: this step takes all files from its source">everything it gets</span>}
          {graph && isFilterEmpty(filter) && <span className={styles.muted} data-tip="No filter: this step takes everything that arrives on its wire">everything on its wire</span>}
          <FiltersPopover filter={filter} onChange={(f) => onChange({ filter: f })} />
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
        <Button size="sm" variant="secondary" icon="copy" data-tip="Add a copy of this step with the same options" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" icon="trash-2" data-tip="Take this step out of the pipeline" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
