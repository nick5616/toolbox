/**
 * The pipeline editor's panels (Phase 11, SPEC §5.6): Step, Triggers, Runs and
 * About. Each takes no props and reads `useDraft`, so it renders the same in a
 * click-in drawer and popped out in its own window (where the store is a
 * replica and every action runs on the host).
 */
import { useMemo } from "react";
import { Button, EmptyState, Field, PathText, Switch, TextField } from "@/components";
import type { Pipeline, StepCheck, StepType } from "@/lib/api";
import { useDraft } from "./draftStore";
import { stepsOf } from "./editorModel";
import { StepOptions } from "./StepOptions";
import { stepName } from "./stepHelpers";
import styles from "./panels.module.css";

export function watchSummary(folder: string, enabled: boolean): string {
  if (!enabled) return "Off";
  return `Watching ${folder ? (folder.split(/[\\/]/).filter(Boolean).pop() ?? folder) : "a folder (not chosen)"}`;
}

export function stepPanelSummary(stepId: string | null, draft: Pipeline | null, catalog: readonly StepType[]): string {
  const s = draft ? stepsOf(draft).find((x) => x.id === stepId) : undefined;
  return s ? stepName(s, catalog.find((t) => t.id === s.type)) : "No step picked";
}

/** The options of the selected node. */
export function StepPanel() {
  const draft = useDraft((s) => s.draft);
  const check = useDraft((s) => s.check);
  const catalog = useDraft((s) => s.catalog);
  const stepId = useDraft((s) => s.stepId);
  const patchStep = useDraft((s) => s.patchStep);
  const keepTouched = useDraft((s) => s.keepTouched);
  const duplicateStep = useDraft((s) => s.duplicateStep);
  const removeStep = useDraft((s) => s.removeStep);
  const checkById = useMemo(() => new Map<string, StepCheck>((check.steps ?? []).map((s) => [s.stepId, s] as const)), [check.steps]);
  const steps = useMemo(() => (draft ? stepsOf(draft) : []), [draft]);
  const index = steps.findIndex((s) => s.id === stepId);
  const step = index >= 0 ? steps[index] : undefined;
  if (!step) return <EmptyState icon="mouse-pointer-2" title="Pick a step" body="Choose a node in the graph to see its options here." />;
  return (
    <div className={styles.stepBody} data-no-wheel="1">
      <StepOptions
        graph
        step={step}
        steps={steps}
        index={index}
        catalog={catalog}
        checkById={checkById}
        onChange={(patch) => patchStep(step.id, patch)}
        onKeepTouched={() => keepTouched(step.id)}
        onDuplicate={() => duplicateStep(step.id)}
        onRemove={() => removeStep(step.id)}
      />
    </div>
  );
}

/** Watch folder and the other ways a run starts. Inline in List mode, a panel in Graph mode. */
export function TriggersBody() {
  const watch = useDraft((s) => s.draft?.watch);
  const watchMessage = useDraft((s) => s.watchMessage);
  const setWatchEnabled = useDraft((s) => s.setWatchEnabled);
  const chooseFolder = useDraft((s) => s.chooseFolder);
  if (!watch) return null;
  return (
    <>
      <div className={styles.watch}>
        <Switch checked={watch.enabled} onChange={setWatchEnabled} label="Watch a folder" tip="Run this pipeline automatically on every new file that appears in a folder" />
        {watch.folder && <PathText path={watch.folder} />}
        <Button size="sm" variant="secondary" data-tip="Pick the folder to watch for new files" onClick={() => void chooseFolder()}>
          Choose…
        </Button>
      </div>
      {watch.enabled && watchMessage && (
        <p className={styles.watchMessage} data-tip="Status of the folder watcher">
          {watchMessage}
        </p>
      )}
      <p className={styles.muted}>Also: drop files on this pipeline, Library → Send to, or the command palette.</p>
    </>
  );
}

export function TriggersPanel() {
  return (
    <div className={styles.pad}>
      <TriggersBody />
    </div>
  );
}

/** This pipeline's run history line and the link to the Runs tab. */
export function RunHistoryBody() {
  const runText = useDraft((s) => s.runText);
  const runCount = useDraft((s) => s.runCount);
  const openRuns = useDraft((s) => s.openRuns);
  return (
    <div className={styles.history}>
      <span>Run history: {runText}</span>
      {runCount > 0 && (
        <Button size="sm" variant="ghost" data-tip="See this pipeline's runs in the Runs tab" onClick={openRuns}>
          Runs →
        </Button>
      )}
    </div>
  );
}

export function RunHistoryPanel() {
  return (
    <div className={styles.pad}>
      <RunHistoryBody />
    </div>
  );
}

/** Name and description (both editable in either mode). */
export function AboutPanel() {
  const name = useDraft((s) => s.draft?.name ?? "");
  const description = useDraft((s) => s.draft?.description ?? "");
  const setName = useDraft((s) => s.setName);
  const setDescription = useDraft((s) => s.setDescription);
  return (
    <div className={styles.about}>
      <Field label="Name">
        {(c) => <TextField {...c} data-tip="The name shown in the list and the command palette" value={name} maxLength={80} placeholder="Name this pipeline" onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Description">
        {(c) => (
          <TextField
            {...c}
            data-tip="A note for yourself about what this pipeline is for"
            value={description}
            maxLength={300}
            placeholder="Add a description"
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}
