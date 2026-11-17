import { useMemo } from "react";
import { create } from "zustand";
import {
  PipelinesService,
  RunStatus,
  WaitKind,
  CellStatus,
  type PipelineEntry,
  type PipelineRun,
  type PipelineStep,
  type PipelineTemplate,
  type RunCell,
  type RunFile,
  type RunItem,
  type StepType,
} from "@/lib/api";

// Pipelines state (SPEC.md §11.8): saved pipelines, the step catalogue, the
// templates, and the runs the UI knows about. Go's nullable slices are
// normalised here so views never see null.

export type RunFileView = RunFile;
export type RunCellView = Omit<RunCell, "jobIds" | "inputs" | "files"> & { jobIds: string[]; inputs: RunFile[]; files: RunFile[] };
export type RunItemView = Omit<RunItem, "merged" | "cells" | "vars"> & { merged: number[]; cells: RunCellView[]; vars: Record<string, string> };
export type RunView = Omit<PipelineRun, "steps" | "inputs" | "items"> & { steps: PipelineStep[]; inputs: string[]; items: RunItemView[] };

function cleanVars(v: { [_ in string]?: string } | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) if (val !== undefined) out[k] = val;
  return out;
}

export function normalizeRun(r: PipelineRun): RunView {
  return {
    ...r,
    steps: (r.steps ?? []).map(normalizeStep),
    inputs: r.inputs ?? [],
    items: (r.items ?? []).map((it) => ({
      ...it,
      merged: it.merged ?? [],
      vars: cleanVars(it.vars),
      cells: (it.cells ?? []).map((c) => ({ ...c, jobIds: c.jobIds ?? [], inputs: c.inputs ?? [], files: c.files ?? [] })),
    })),
  };
}

export function normalizeStep(s: PipelineStep): PipelineStep {
  return {
    ...s,
    filter: {
      roles: s.filter?.roles ?? [],
      kinds: s.filter?.kinds ?? [],
      exts: s.filter?.exts ?? [],
      name: s.filter?.name ?? "",
    },
  };
}

export function normalizeEntry(e: PipelineEntry): PipelineEntry {
  const c = e.check;
  return {
    ...e,
    pipeline: { ...e.pipeline, steps: (e.pipeline.steps ?? []).map(normalizeStep) },
    check: {
      ...c,
      steps: (c.steps ?? []).map((s) => ({
        ...s,
        problems: s.problems ?? [],
        vars: s.vars ?? [],
        info: {
          ...s.info,
          produces: s.info.produces ?? [],
          vars: s.info.vars ?? [],
          secrets: s.info.secrets ?? [],
          templates: s.info.templates ?? [],
          warnings: s.info.warnings ?? [],
          accepts: { ...s.info.accepts, extensions: s.info.accepts.extensions ?? [] },
        },
      })),
      problems: c.problems ?? [],
      secrets: c.secrets ?? [],
      missing: c.missing ?? [],
      accepts: { ...c.accepts, extensions: c.accepts.extensions ?? [] },
    },
  };
}

export function isRunActive(r: Pick<PipelineRun, "status">): boolean {
  return r.status === RunStatus.RunRunning || r.status === RunStatus.RunWaiting;
}

export type PipelinesTab = "pipelines" | "runs";

export interface RunSheetState {
  pipelineId: string;
  inputs: string[];
}

interface PipelinesState {
  entries: PipelineEntry[];
  catalog: StepType[];
  templates: PipelineTemplate[];
  runs: Record<string, RunView>;
  loaded: boolean;

  tab: PipelinesTab;
  selectedPipelineId: string | null;
  selectedRunId: string | null;
  /** Runs tab filter: "" = all pipelines. */
  runFilter: string;
  runSheet: RunSheetState | null;

  setEntries: (entries: PipelineEntry[]) => void;
  upsertRun: (run: PipelineRun) => void;
  setRuns: (runs: PipelineRun[]) => void;
  removeRuns: (ids: string[]) => void;
  /** Loads entries, catalogue, templates and recent runs. */
  load: () => Promise<void>;
  /** Loads the catalogue and templates if not yet loaded (they never change at runtime). */
  ensureCatalog: () => Promise<void>;

  setTab: (tab: PipelinesTab) => void;
  selectPipeline: (id: string | null) => void;
  setRunFilter: (pipelineId: string) => void;
  showRun: (runId: string) => void;
  openRunSheet: (pipelineId: string, inputs?: string[]) => void;
  setRunSheetInputs: (inputs: string[]) => void;
  closeRunSheet: () => void;
}

export const usePipelines = create<PipelinesState>((set, get) => ({
  entries: [],
  catalog: [],
  templates: [],
  runs: {},
  loaded: false,

  tab: "pipelines",
  selectedPipelineId: null,
  selectedRunId: null,
  runFilter: "",
  runSheet: null,

  setEntries: (entries) => set({ entries: entries.map(normalizeEntry) }),
  upsertRun: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: normalizeRun(run) } })),
  setRuns: (runs) => set((s) => ({ runs: { ...s.runs, ...Object.fromEntries(runs.map((r) => [r.id, normalizeRun(r)])) } })),
  removeRuns: (ids) =>
    set((s) => {
      const runs = { ...s.runs };
      for (const id of ids) delete runs[id];
      return { runs, selectedRunId: s.selectedRunId && ids.includes(s.selectedRunId) ? null : s.selectedRunId };
    }),
  load: async () => {
    // The catalogue loads alongside the list; `loaded` flips as soon as the list and runs are in.
    const catalog = get().ensureCatalog();
    catalog.catch(() => undefined); // surfaced below; avoid an unhandled rejection if List fails first
    const [entries, runs] = await Promise.all([
      PipelinesService.List(),
      PipelinesService.Runs({ pipelineId: "", activeOnly: false, limit: 50 }),
    ]);
    get().setEntries(entries ?? []);
    get().setRuns(runs ?? []);
    set({ loaded: true });
    await catalog;
  },
  ensureCatalog: async () => {
    if (get().catalog.length > 0) return;
    const [catalog, templates] = await Promise.all([PipelinesService.Catalog(), PipelinesService.Templates()]);
    set({ catalog: catalog ?? [], templates: templates ?? [] });
  },

  setTab: (tab) => set({ tab }),
  selectPipeline: (selectedPipelineId) => set({ selectedPipelineId }),
  setRunFilter: (runFilter) => set({ runFilter }),
  showRun: (runId) => set({ tab: "runs", selectedRunId: runId }),
  openRunSheet: (pipelineId, inputs = []) => set({ runSheet: { pipelineId, inputs } }),
  setRunSheetInputs: (inputs) => set((s) => (s.runSheet ? { runSheet: { ...s.runSheet, inputs } } : s)),
  closeRunSheet: () => set({ runSheet: null }),
}));

/** Runs newest first. */
export function useRunList(): RunView[] {
  const runs = usePipelines((s) => s.runs);
  return useMemo(() => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt), [runs]);
}

/** One waiting manual or check cell (a "needs you" card). */
export interface WaitingCell {
  run: RunView;
  item: RunItemView;
  cell: RunCellView;
  step: PipelineStep;
  stepIndex: number;
  kind: WaitKind;
}

export function waitingCells(runs: Record<string, RunView>): WaitingCell[] {
  const out: WaitingCell[] = [];
  for (const run of Object.values(runs).sort((a, b) => a.createdAt - b.createdAt)) {
    if (!isRunActive(run)) continue;
    for (const item of run.items) {
      item.cells.forEach((cell, stepIndex) => {
        const step = run.steps[stepIndex];
        if (!step || cell.status !== CellStatus.CellWaiting) return;
        if (cell.wait !== WaitKind.WaitManual && cell.wait !== WaitKind.WaitCheck) return;
        out.push({ run, item, cell, step, stepIndex, kind: cell.wait });
      });
    }
  }
  return out;
}

/** Every cell waiting for the user, oldest run first. */
export function useNeedsYou(): WaitingCell[] {
  const runs = usePipelines((s) => s.runs);
  return useMemo(() => waitingCells(runs), [runs]);
}

/** Manual cells waiting for this module's tool (the shell banner). */
export function useWaitingForModule(moduleId: string): WaitingCell[] {
  const all = useNeedsYou();
  return useMemo(() => all.filter((w) => w.kind === WaitKind.WaitManual && w.step.type === moduleId), [all, moduleId]);
}

/** A run's name, "" if unknown (job tray chips). */
export function useRunName(runId: string): string {
  return usePipelines((s) => (runId ? (s.runs[runId]?.name ?? "") : ""));
}

/** The pipeline entry by ID. */
export function usePipelineEntry(id: string | null): PipelineEntry | undefined {
  return usePipelines((s) => (id ? s.entries.find((e) => e.pipeline.id === id) : undefined));
}
