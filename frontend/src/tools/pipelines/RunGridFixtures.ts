import { CellStatus, ErrorCode, OutputKind, RunStatus, WaitKind, type PipelineRun, type RunCell, type RunFile, type RunItem } from "@/lib/api";
import { step } from "./testFixtures";

// Run fixtures for the Runs tab and shell tests.

export const file = (path: string, o: Partial<RunFile> = {}): RunFile => ({
  path,
  name: path.split("/").pop() ?? path,
  kind: OutputKind.KindAudio,
  role: "main",
  roleLabel: "",
  outputId: "",
  temporary: false,
  missing: false,
  ...o,
});

export const cell = (stepId: string, status: CellStatus, o: Partial<RunCell> = {}): RunCell => ({
  stepId,
  status,
  wait: WaitKind.$zero,
  jobIds: [],
  inputs: [],
  files: [],
  message: "",
  errorCode: ErrorCode.$zero,
  error: "",
  errorHint: "",
  startedAt: 0,
  finishedAt: 0,
  ...o,
});

export const item = (index: number, label: string, cells: RunCell[], o: Partial<RunItem> = {}): RunItem => ({
  index,
  label,
  input: `/in/${label}`,
  merged: [],
  mergedAt: "",
  cells,
  vars: {},
  ...o,
});

export const run = (id: string, o: Partial<PipelineRun> = {}): PipelineRun => ({
  id,
  pipelineId: "p1",
  name: `Run ${id}`,
  steps: [step("s1", "stems"), step("s2", "trimmer", { manual: true })],
  status: RunStatus.RunRunning,
  trigger: "manual",
  inputs: [],
  items: [],
  needsYou: 0,
  error: "",
  cleaned: false,
  createdAt: 1000,
  finishedAt: 0,
  ...o,
});
