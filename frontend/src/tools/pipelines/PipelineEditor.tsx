import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Banner, Button, ClickInHost, ConfirmDialog, EmptyState, IconButton, MenuButton, SegmentedControl, ToolHeader, Tooltip, cx, toast, useClickIn } from "@/components";
import { PipelinesService, RunStatus, type PipelineEntry, type PipelineStep, type StepCheck, type StepType } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { toAppError } from "@/lib/errors";
import { describeAccepts } from "@/pipelines/compat";
import { useModules } from "@/state/modules";
import { isRunActive, usePipelineEntry, usePipelines } from "@/state/pipelines";
import { panelDrawerId, WorkspacePanel } from "@/workspace";
import { AddStepMenu } from "./AddStepMenu";
import { openToolPacks } from "./createPipeline";
import { touchedKeep, useDraft } from "./draftStore";
import { duplicateStep, firstProblem, stepsOf, insertStep, moveStep, newStep, removeStep, withEntry } from "./editorModel";
import { PipelinesTabs } from "./PipelinesTabs";
import { useEditorMode } from "./editorMode";
import { GraphEditor } from "./GraphEditor";
import { RunHistoryBody, TriggersBody, stepPanelSummary, triggersSummary } from "./panels";
import { StepCard } from "./StepCard";
import { pipelinesWorkspace } from "./workspace";
import styles from "./PipelineEditor.module.css";

export { SAVE_DELAY_MS, DESCRIBE_DELAY_MS } from "./draftStore";

const RUN_STATUS_TEXT: Record<string, string> = {
  [RunStatus.RunRunning]: "running",
  [RunStatus.RunWaiting]: "needs you",
  [RunStatus.RunDone]: "done",
  [RunStatus.RunPartial]: "finished with problems",
  [RunStatus.RunFailed]: "failed",
  [RunStatus.RunCancelled]: "cancelled",
};

/** The editor of the selected pipeline (SPEC.md §11.2). */
export interface PipelineEditorProps {
  /** Opens the template gallery; with it, Graph mode shows a pipeline switcher (the list is hidden then). */
  onNew?: () => void;
}

export function PipelineEditor({ onNew }: PipelineEditorProps = {}) {
  const selected = usePipelines((s) => s.selectedPipelineId);
  const entry = usePipelineEntry(selected);
  if (!entry) {
    return (
      <div className={styles.empty}>
        <EmptyState icon="workflow" title="Select or create a pipeline" body="Its steps appear here." />
      </div>
    );
  }
  return <EditorBody key={entry.pipeline.id} entry={entry} onNew={onNew} />;
}

function EditorBody({ entry, onNew }: { entry: PipelineEntry; onNew?: () => void }) {
  const pipelineId = entry.pipeline.id;
  const ready = useDraft((s) => s.pipelineId === pipelineId && s.draft !== null);
  // Layout effect: the previous pipeline's body has already flushed (its cleanup runs first).
  useLayoutEffect(() => {
    useDraft.getState().open(entry);
    return () => useDraft.getState().close();
    // The draft is opened once per pipeline; later entry updates (after saves) must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId]);
  if (!ready) return null;
  return (
    <ClickInHost className={styles.root}>
      <EditorInner entry={entry} onNew={onNew} />
    </ClickInHost>
  );
}

function EditorInner({ entry, onNew }: { entry: PipelineEntry; onNew?: () => void }) {
  const pipelineId = entry.pipeline.id;
  const catalog = usePipelines((s) => s.catalog);
  const runs = usePipelines((s) => s.runs);
  const selectPipeline = usePipelines((s) => s.selectPipeline);
  const openRunSheet = usePipelines((s) => s.openRunSheet);

  const draft = useDraft((s) => s.draft) ?? entry.pipeline;
  const check = useDraft((s) => s.check);
  const saveState = useDraft((s) => s.saveState);
  const canUndo = useDraft((s) => s.canUndo);
  const canRedo = useDraft((s) => s.canRedo);
  const stepId = useDraft((s) => s.stepId);
  const edit = useDraft((s) => s.edit);
  const editLayout = useDraft((s) => s.editLayout);
  const undo = useDraft((s) => s.undo);
  const redo = useDraft((s) => s.redo);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);
  const [mode, setMode] = useEditorMode();
  const modules = useModules((s) => s.list);
  const { open: openDrawer } = useClickIn();
  pipelinesWorkspace.useHost();

  const focusHandle = useRef<string | null>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const dragCleanup = useRef<(() => void) | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => () => dragCleanup.current?.(), []);

  // Mod+Z / Mod+Shift+Z / Mod+Y; text fields keep their own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y" && !e.shiftKey) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  useLayoutEffect(() => {
    const id = focusHandle.current;
    if (!id) return;
    focusHandle.current = null;
    document.querySelector<HTMLElement>(`[data-step-handle="${id}"]`)?.focus();
  }, [draft.steps]);

  const checkById = useMemo(() => new Map<string, StepCheck>((check.steps ?? []).map((s) => [s.stepId, s] as const)), [check.steps]);
  const steps = stepsOf(draft);

  const patchStep = (id: string, patch: Partial<PipelineStep>) => useDraft.getState().patchStep(id, patch);

  const addStep = (type: StepType, index: number) => {
    const s = newStep(type, stepsOf(draftRef.current), check, index);
    edit((p) => ({ ...p, steps: insertStep(stepsOf(p), index, s, touchedKeep) }));
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

  const flush = () => useDraft.getState().flush();

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
      useDraft.getState().markDeleted();
      const s = usePipelines.getState();
      s.setEntries(s.entries.filter((e) => e.pipeline.id !== pipelineId));
    } catch (e) {
      toast({ title: "Couldn't delete the pipeline", description: toAppError(e).message, tone: "danger" });
    }
  };

  const myRuns = useMemo(() => Object.values(runs).filter((r) => r.pipelineId === pipelineId), [runs, pipelineId]);
  const activeRunList = useMemo(() => myRuns.filter(isRunActive), [myRuns]);
  const activeRuns = activeRunList.length;
  const lastRun = useMemo(() => {
    const newest = [...myRuns].sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest ? { status: newest.status as string, at: newest.createdAt } : entry.lastRun ? { status: entry.lastRun.status as string, at: entry.lastRun.createdAt } : null;
  }, [myRuns, entry.lastRun]);
  const runCount = Math.max(myRuns.length, entry.lastRun ? 1 : 0);

  const inPage = !!onNew;
  const compact = mode === "graph" && inPage;
  const showNew = inPage && !compact;
  const blocked = !check.ready;
  const problem = firstProblem(check);
  const pipelineProblems = check.problems ?? [];
  const missing = check.missing ?? [];
  const status = check.ready ? "Ready" : missing.length > 0 && pipelineProblems.length === 0 ? "Tools missing" : "Has problems";

  const historyText = `${runCount === 0 ? "no runs yet" : `${runCount} ${runCount === 1 ? "run" : "runs"}`}${lastRun ? ` · last: ${RUN_STATUS_TEXT[lastRun.status] ?? lastRun.status} ${formatRelativeTime(lastRun.at)}` : ""}`;
  const watchText = triggersSummary(draft.watch.folder, draft.watch.enabled, draft.clip);
  const watchMessage = draft.watch.enabled ? entry.watch.message : "";
  const clipActive = draft.clip.enabled && entry.clip.active;
  const clipMessage = draft.clip.enabled ? entry.clip.message : "";

  // What the panels (and popped-out copies of them) show comes from here.
  useEffect(() => {
    useDraft.getState().setLive({ watchMessage, clipStatus: { active: clipActive, message: clipMessage }, runText: historyText, runCount, catalog: [...catalog] });
  }, [watchMessage, clipActive, clipMessage, historyText, runCount, catalog]);

  const openStep = (id: string, pointer?: string) => {
    useDraft.getState().select(id);
    openDrawer(panelDrawerId("step"));
    if (!pointer) return;
    // Scroll the panel to that setting's field when the editor can say where it is (data-param="<pointer>"); otherwise it opens at the top.
    window.setTimeout(() => {
      const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(pointer) : pointer.replace(/["\\]/g, "\\$&");
      document.querySelector<HTMLElement>(`[data-param="${esc}"]`)?.scrollIntoView?.({ block: "center" });
    }, 60);
  };

  return (
    <>
      <ToolHeader className={styles.header} aria-label="Pipeline">
        {inPage && (
          <span className={styles.tabs}>
            <PipelinesTabs />
          </span>
        )}
        {inPage && (
          <MenuButton
            label="Pipelines"
            icon="workflow"
            variant="ghost"
            size="sm"
            tip="Switch to another pipeline or make a new one"
            items={() => [
              ...usePipelines.getState().entries.map((e) => ({
                id: e.pipeline.id,
                label: e.pipeline.name,
                icon: e.pipeline.id === pipelineId ? "check" : "workflow",
                tip: e.pipeline.id === pipelineId ? "The pipeline you are editing" : "Open this pipeline",
                onSelect: () => selectPipeline(e.pipeline.id),
              })),
              { id: "__new", label: "New pipeline…", icon: "plus", tip: "Start from a template or an empty pipeline", onSelect: onNew },
            ]}
          />
        )}
        <div className={styles.titles}>
          <input
            className={cx(styles.name, styles.nameFlush)}
            aria-label="Pipeline name"
            data-tip={compact && draft.description ? draft.description : "The name shown in the list and the command palette"}
            title={compact ? draft.description : undefined}
            value={draft.name}
            maxLength={80}
            placeholder="Name this pipeline"
            onChange={(e) => useDraft.getState().setName(e.target.value)}
          />
        </div>
        <span className={styles.statusInline}>
          <span className={styles.takes} data-tip="The kinds of files you can start this pipeline with">
            Takes: {describeAccepts(check.accepts)}
            {" · "}
          </span>
          <span data-tip={check.ready ? "Every step is set up and its tools are installed" : missing.length > 0 ? "Install the missing tool packs to run this" : "Fix the problems listed to run this"} className={check.ready ? styles.ok : missing.length > 0 ? styles.warn : styles.bad}>● {status}</span>
        </span>
        <div className={styles.actions}>
          <IconButton size="sm" icon="undo-2" label="Undo" disabled={!canUndo} onClick={undo} />
          <IconButton size="sm" icon="redo-2" label="Redo" disabled={!canRedo} onClick={redo} />
          <SegmentedControl
            size="sm"
            aria-label="Editor view"
            value={mode}
            onChange={setMode}
            options={[
              { value: "graph", label: "Graph", tip: "Wire tools together on a canvas" },
              { value: "list", label: "List", tip: "Edit the steps as a list, top to bottom" },
            ]}
          />
          <span className={styles.saveState} role="status" aria-live="polite" data-tip="Changes save automatically a moment after you make them">
            {saveState.kind === "saving" && "Saving…"}
            {saveState.kind === "saved" && "Saved"}
            {saveState.kind === "error" && <span className={styles.saveError}>Couldn&apos;t save: {saveState.message}</span>}
          </span>
          {showNew && <IconButton size="sm" icon="plus" label="New pipeline" data-tip="Create a pipeline from a ready-made template or from scratch" onClick={onNew} />}
          <Tooltip label={blocked ? problem || "Fix the problems first" : "Run on files or links"} side="bottom">
            <Button size="sm" variant="primary" icon="play" disabled={blocked} onClick={() => void runNow()}>
              Run…
            </Button>
          </Tooltip>
          <MenuButton
            label="Pipeline actions"
            tip="Duplicate or delete this pipeline"
            icon="ellipsis"
            variant="ghost"
            size="sm"
            items={() => [
              { id: "duplicate", label: "Duplicate", icon: "copy", tip: "Make a copy of this pipeline to change without touching the original", onSelect: () => void duplicatePipeline() },
              { id: "delete", label: "Delete…", icon: "trash-2", tip: "Remove this pipeline; files from earlier runs stay", onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
      </ToolHeader>

      <div className={cx(styles.scroll, mode === "graph" && styles.scrollGraph)}>
        {!compact && (
          <input
            className={styles.description}
            aria-label="Description"
            data-tip={draft.description || "A note for yourself about what this pipeline is for"}
            title={draft.description}
            value={draft.description}
            maxLength={300}
            placeholder="Add a description"
            onChange={(e) => useDraft.getState().setDescription(e.target.value)}
          />
        )}

        {(pipelineProblems.length > 0 || missing.length > 0) && <div className={styles.banners}>
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
              <Button size="sm" variant="secondary" data-tip="Open Settings to install the packs that contain these tools" onClick={openToolPacks}>
                Tool packs
              </Button>
            }
          >
            {missing.join(", ")}
          </Banner>
        )}
        </div>}

        {mode === "graph" ? (
          <GraphEditor
            pipeline={draft}
            check={check}
            catalog={catalog}
            modules={modules}
            runs={activeRunList}
            dropTargetId={`pipeline-drop:${pipelineId}`}
            onEdit={edit}
            onLayout={editLayout}
            onOpenStep={openStep}
            touchedKeep={touchedKeep}
          />
        ) : (
          <>
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
                    onKeepTouched={() => touchedKeep.add(s.id)}
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
          </>
        )}

        {mode === "list" ? (
          <>
            <section className={styles.section} aria-label="Triggers">
              <h3 className={styles.sectionTitle} data-tip="Ways a run can start besides pressing Run">Triggers</h3>
              <TriggersBody />
            </section>

            <section className={styles.section} aria-label="Run history"><RunHistoryBody /></section>
          </>
        ) : (
          <div className={styles.footer}>
            <WorkspacePanel ws={pipelinesWorkspace} panel="step" summary={stepPanelSummary(stepId, draft, catalog)} className={styles.footerItem} />
            <WorkspacePanel ws={pipelinesWorkspace} panel="triggers" summary={watchText} className={styles.footerItem} />
            <WorkspacePanel ws={pipelinesWorkspace} panel="runs" summary={historyText} className={styles.footerItem} />
            <WorkspacePanel ws={pipelinesWorkspace} panel="about" summary={draft.description || draft.name} className={styles.footerItem} />
          </div>
        )}
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
    </>
  );
}
