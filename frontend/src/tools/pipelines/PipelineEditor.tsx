import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Banner, Button, ConfirmDialog, EmptyState, MenuButton, PathText, Switch, Tooltip, cx, toast } from "@/components";
import {
  FilesService,
  PipelinesService,
  RunStatus,
  type Pipeline,
  type PipelineCheck,
  type PipelineEntry,
  type PipelineStep,
  type StepCheck,
  type StepType,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { toAppError } from "@/lib/errors";
import { describeAccepts } from "@/pipelines/compat";
import { isRunActive, normalizeEntry, usePipelineEntry, usePipelines } from "@/state/pipelines";
import { AddStepMenu } from "./AddStepMenu";
import { openToolPacks } from "./createPipeline";
import { duplicateStep, firstProblem, stepsOf, insertStep, moveStep, newStep, removeStep, withEntry } from "./editorModel";
import { StepCard } from "./StepCard";
import styles from "./PipelineEditor.module.css";

export const SAVE_DELAY_MS = 600;
export const DESCRIBE_DELAY_MS = 250;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const RUN_STATUS_TEXT: Record<string, string> = {
  [RunStatus.RunRunning]: "running",
  [RunStatus.RunWaiting]: "needs you",
  [RunStatus.RunDone]: "done",
  [RunStatus.RunPartial]: "finished with problems",
  [RunStatus.RunFailed]: "failed",
  [RunStatus.RunCancelled]: "cancelled",
};

function normalizeCheck(pipeline: Pipeline, check: PipelineCheck): PipelineCheck {
  return normalizeEntry({ pipeline, check, watch: { active: false, message: "" }, lastRun: null }).check;
}

/** Saves a pipeline and tells the store about it. */
async function persist(p: Pipeline): Promise<PipelineEntry> {
  const saved = await PipelinesService.Save(p);
  const s = usePipelines.getState();
  s.setEntries(withEntry(s.entries, saved));
  return saved;
}

/** The editor of the selected pipeline (SPEC.md §11.2). */
export function PipelineEditor() {
  const selected = usePipelines((s) => s.selectedPipelineId);
  const entry = usePipelineEntry(selected);
  if (!entry) {
    return (
      <div className={styles.empty}>
        <EmptyState icon="workflow" title="Select or create a pipeline" body="Its steps appear here." />
      </div>
    );
  }
  return <EditorBody key={entry.pipeline.id} entry={entry} />;
}

function EditorBody({ entry }: { entry: PipelineEntry }) {
  const pipelineId = entry.pipeline.id;
  const catalog = usePipelines((s) => s.catalog);
  const runs = usePipelines((s) => s.runs);
  const setTab = usePipelines((s) => s.setTab);
  const setRunFilter = usePipelines((s) => s.setRunFilter);
  const openRunSheet = usePipelines((s) => s.openRunSheet);

  const [draft, setDraft] = useState<Pipeline>(entry.pipeline);
  const [check, setCheck] = useState<PipelineCheck>(entry.check);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);

  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const resaveRef = useRef(false);
  const deletedRef = useRef(false);
  const mountedRef = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const describeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const describeSeq = useRef(0);
  const touchedKeep = useRef(new Set<string>());
  const focusHandle = useRef<string | null>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const dragCleanup = useRef<(() => void) | null>(null);

  const runDescribe = useCallback(() => {
    const p = draftRef.current;
    const seq = ++describeSeq.current;
    PipelinesService.Describe(p)
      .then((c) => {
        if (mountedRef.current && seq === describeSeq.current) setCheck(normalizeCheck(p, c));
      })
      .catch(() => undefined); // keep the last answer; saving still works
  }, []);

  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    if (!dirtyRef.current || deletedRef.current) return;
    if (savingRef.current) {
      resaveRef.current = true;
      return;
    }
    savingRef.current = true;
    dirtyRef.current = false;
    if (mountedRef.current) setSaveState({ kind: "saving" });
    try {
      await persist(draftRef.current);
      if (mountedRef.current) setSaveState(dirtyRef.current ? { kind: "saving" } : { kind: "saved" });
    } catch (e) {
      dirtyRef.current = true;
      if (mountedRef.current) setSaveState({ kind: "error", message: toAppError(e).message });
    } finally {
      savingRef.current = false;
      if (resaveRef.current) {
        resaveRef.current = false;
        void save();
      }
    }
  }, []);

  const edit = useCallback(
    (fn: (p: Pipeline) => Pipeline) => {
      const next = fn(draftRef.current);
      draftRef.current = next;
      dirtyRef.current = true;
      setDraft(next);
      clearTimeout(saveTimer.current);
      clearTimeout(describeTimer.current);
      saveTimer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
      describeTimer.current = setTimeout(runDescribe, DESCRIBE_DELAY_MS);
    },
    [save, runDescribe],
  );

  // Flush a pending save when leaving this pipeline.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(saveTimer.current);
      clearTimeout(describeTimer.current);
      dragCleanup.current?.();
      if (dirtyRef.current && !deletedRef.current && !savingRef.current) {
        dirtyRef.current = false;
        void persist(draftRef.current).catch((e: unknown) =>
          toast({ title: "Couldn't save the pipeline", description: toAppError(e).message, tone: "danger" }),
        );
      }
    };
  }, []);

  useLayoutEffect(() => {
    const id = focusHandle.current;
    if (!id) return;
    focusHandle.current = null;
    document.querySelector<HTMLElement>(`[data-step-handle="${id}"]`)?.focus();
  }, [draft.steps]);

  const checkById = useMemo(() => new Map<string, StepCheck>((check.steps ?? []).map((s) => [s.stepId, s] as const)), [check.steps]);
  const steps = stepsOf(draft);

  const patchStep = (id: string, patch: Partial<PipelineStep>) =>
    edit((p) => ({ ...p, steps: stepsOf(p).map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const addStep = (type: StepType, index: number) => {
    const s = newStep(type, stepsOf(draftRef.current), check, index);
    edit((p) => ({ ...p, steps: insertStep(stepsOf(p), index, s, touchedKeep.current) }));
    if (type.id === "visualizer") setExpanded(s.id);
  };

  const removeById = (id: string) => {
    edit((p) => ({ ...p, steps: removeStep(stepsOf(p), id) }));
    setExpanded((x) => (x === id ? null : x));
  };

  const duplicateById = (id: string) => {
    const res = duplicateStep(stepsOf(draftRef.current), id);
    edit((p) => ({ ...p, steps: res.steps }));
    if (res.id) setExpanded(res.id);
  };

  const moveTo = (from: number, to: number) => {
    const id = stepsOf(draftRef.current)[from]?.id;
    if (!id || to < 0 || to >= stepsOf(draftRef.current).length) return;
    focusHandle.current = id;
    edit((p) => ({ ...p, steps: moveStep(stepsOf(p), from, to) }));
  };

  const onHandleDown = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = stepsOf(draftRef.current).findIndex((s) => s.id === id);
    let to = from;
    setDrag({ id, to });
    const targetAt = (y: number): number => {
      const list = stepsOf(draftRef.current);
      for (let i = 0; i < list.length; i++) {
        const r = cardEls.current.get(list[i]?.id ?? "")?.getBoundingClientRect();
        if (r && y < r.top + r.height / 2) return i;
      }
      return list.length - 1;
    };
    const onMove = (ev: PointerEvent) => {
      const t = targetAt(ev.clientY);
      if (t !== to) {
        to = t;
        setDrag({ id, to });
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragCleanup.current = null;
    };
    const onUp = () => {
      stop();
      setDrag(null);
      if (to !== from) moveTo(from, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dragCleanup.current = stop;
  };

  const flush = async () => {
    clearTimeout(saveTimer.current);
    await save();
  };

  const runNow = async () => {
    await flush();
    openRunSheet(pipelineId);
  };

  const duplicatePipeline = async () => {
    try {
      await flush();
      const copy = await PipelinesService.Duplicate(pipelineId);
      const s = usePipelines.getState();
      s.setEntries(withEntry(s.entries, copy));
      s.selectPipeline(copy.pipeline.id);
    } catch (e) {
      toast({ title: "Couldn't duplicate the pipeline", description: toAppError(e).message, tone: "danger" });
    }
  };

  const deletePipeline = async () => {
    setConfirmDelete(false);
    try {
      await PipelinesService.Delete(pipelineId);
      deletedRef.current = true;
      dirtyRef.current = false;
      clearTimeout(saveTimer.current);
      const s = usePipelines.getState();
      s.setEntries(s.entries.filter((e) => e.pipeline.id !== pipelineId));
    } catch (e) {
      toast({ title: "Couldn't delete the pipeline", description: toAppError(e).message, tone: "danger" });
    }
  };

  const chooseFolder = async () => {
    try {
      const dir = await FilesService.PickFolder("Watch folder");
      if (dir) edit((p) => ({ ...p, watch: { ...p.watch, folder: dir } }));
    } catch (e) {
      toast({ title: "Couldn't choose a folder", description: toAppError(e).message, tone: "danger" });
    }
  };

  const toggleWatch = (enabled: boolean) => {
    edit((p) => ({ ...p, watch: { ...p.watch, enabled } }));
    if (enabled && !draftRef.current.watch.folder) void chooseFolder();
  };

  const myRuns = useMemo(() => Object.values(runs).filter((r) => r.pipelineId === pipelineId), [runs, pipelineId]);
  const activeRuns = myRuns.filter(isRunActive).length;
  const lastRun = useMemo(() => {
    const newest = [...myRuns].sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest ? { status: newest.status as string, at: newest.createdAt } : entry.lastRun ? { status: entry.lastRun.status as string, at: entry.lastRun.createdAt } : null;
  }, [myRuns, entry.lastRun]);
  const runCount = Math.max(myRuns.length, entry.lastRun ? 1 : 0);

  const blocked = !check.ready;
  const problem = firstProblem(check);
  const pipelineProblems = check.problems ?? [];
  const missing = check.missing ?? [];
  const status = check.ready ? "Ready" : missing.length > 0 && pipelineProblems.length === 0 ? "Tools missing" : "Has problems";

  const watchMessage = draft.watch.enabled ? entry.watch.message : "";

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <input
            className={styles.name}
            aria-label="Pipeline name"
            value={draft.name}
            maxLength={80}
            placeholder="Name this pipeline"
            onChange={(e) => edit((p) => ({ ...p, name: e.target.value }))}
          />
          <input
            className={styles.description}
            aria-label="Description"
            value={draft.description}
            maxLength={300}
            placeholder="Add a description"
            onChange={(e) => edit((p) => ({ ...p, description: e.target.value }))}
          />
        </div>
        <div className={styles.actions}>
          <span className={styles.saveState} role="status" aria-live="polite">
            {saveState.kind === "saving" && "Saving…"}
            {saveState.kind === "saved" && "Saved"}
            {saveState.kind === "error" && <span className={styles.saveError}>Couldn&apos;t save: {saveState.message}</span>}
          </span>
          <Tooltip label={blocked ? problem || "Fix the problems first" : "Run on files or links"} side="bottom">
            <Button variant="primary" icon="play" disabled={blocked} onClick={() => void runNow()}>
              Run…
            </Button>
          </Tooltip>
          <MenuButton
            label="Pipeline actions"
            icon="ellipsis"
            variant="ghost"
            items={() => [
              { id: "duplicate", label: "Duplicate", icon: "copy", onSelect: () => void duplicatePipeline() },
              { id: "delete", label: "Delete…", icon: "trash-2", onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
      </header>

      <div className={styles.scroll}>
        <div className={styles.status}>
          <span>Takes: {describeAccepts(check.accepts)}</span>
          <span className={cx(styles.statusDot, check.ready ? styles.ok : missing.length > 0 ? styles.warn : styles.bad)}>● {status}</span>
        </div>

        {pipelineProblems.length > 0 && (
          <Banner tone="danger" title="This pipeline can't run yet">
            <ul className={styles.problemList}>
              {pipelineProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Banner>
        )}
        {missing.length > 0 && (
          <Banner
            tone="warn"
            title="Some tools aren't installed"
            action={
              <Button size="sm" variant="secondary" onClick={openToolPacks}>
                Tool packs
              </Button>
            }
          >
            {missing.join(", ")}
          </Banner>
        )}

        <ol className={styles.steps} aria-label="Steps">
          {steps.map((s, i) => {
            const dropAbove = drag !== null && drag.to === i && drag.id !== s.id && steps.findIndex((x) => x.id === drag.id) > i;
            const dropBelow = drag !== null && drag.to === i && drag.id !== s.id && steps.findIndex((x) => x.id === drag.id) < i;
            return (
              <Fragment key={s.id}>
                {i > 0 && (
                  <li className={styles.gap} data-step-gap="">
                    <AddStepMenu variant="between" index={i} catalog={catalog} check={check} onPick={(t) => addStep(t, i)} />
                  </li>
                )}
                <li className={cx(styles.item, dropAbove && styles.dropAbove, dropBelow && styles.dropBelow)}>
                  <StepCard
                    index={i}
                    step={s}
                    steps={steps}
                    catalog={catalog}
                    checkById={checkById}
                    expanded={expanded === s.id}
                    onToggle={() => setExpanded((x) => (x === s.id ? null : s.id))}
                    onChange={(patch) => patchStep(s.id, patch)}
                    onKeepTouched={() => touchedKeep.current.add(s.id)}
                    onDuplicate={() => duplicateById(s.id)}
                    onRemove={() => removeById(s.id)}
                    onMove={(d) => moveTo(i, i + d)}
                    onHandlePointerDown={onHandleDown(s.id)}
                    dragging={drag?.id === s.id}
                    cardRef={(el) => {
                      if (el) cardEls.current.set(s.id, el);
                      else cardEls.current.delete(s.id);
                    }}
                  />
                </li>
              </Fragment>
            );
          })}
        </ol>
        <div className={styles.add}>
          <AddStepMenu variant="end" index={steps.length} catalog={catalog} check={check} onPick={(t) => addStep(t, steps.length)} />
        </div>

        <section className={styles.section} aria-label="Triggers">
          <h3 className={styles.sectionTitle}>Triggers</h3>
          <div className={styles.watch}>
            <Switch checked={draft.watch.enabled} onChange={toggleWatch} label="Watch a folder" />
            {draft.watch.folder && <PathText path={draft.watch.folder} />}
            <Button size="sm" variant="secondary" onClick={() => void chooseFolder()}>
              Choose…
            </Button>
          </div>
          {watchMessage && <p className={styles.watchMessage}>{watchMessage}</p>}
          <p className={styles.muted}>Also: drop files on this pipeline, Library → Send to, or the command palette.</p>
        </section>

        <section className={styles.section} aria-label="Run history">
          <div className={styles.history}>
            <span>
              Run history: {runCount === 0 ? "no runs yet" : `${runCount} ${runCount === 1 ? "run" : "runs"}`}
              {lastRun && ` · last: ${RUN_STATUS_TEXT[lastRun.status] ?? lastRun.status} ${formatRelativeTime(lastRun.at)}`}
            </span>
            {runCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRunFilter(pipelineId);
                  setTab("runs");
                }}
              >
                Runs →
              </Button>
            )}
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${draft.name}”?`}
        tone="danger"
        confirmLabel="Delete"
        body={
          activeRuns > 0
            ? `${activeRuns} ${activeRuns === 1 ? "run is" : "runs are"} in progress and will keep going. Finished runs and their files stay.`
            : "Finished runs and their files stay."
        }
        onConfirm={() => void deletePipeline()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
