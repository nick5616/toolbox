import { CellStatus, WaitKind, type PipelineStep } from "@/lib/api";
import type { RunCellView, RunItemView, RunView } from "@/state/pipelines";
import { autoLayout, buildGraph, NODE_W, parseLayout, stepRunCounts, topoSort, type BuildOptions, type Graph, type StepRunCounts } from "./graphModel";
import type { WireVisualState } from "./graph/wireStyle";
import { cellLook, orderItems } from "./RunGridModel";

// Pure logic of the Runs graph: a run's pipeline drawn as the editor's node graph,
// each node carrying its step's state across the run's items.

/** Height of the run block under a node's ports. */
export const RUN_FOOT_H = 48;

export interface StepRunStats extends StepRunCounts {
  skipped: number;
  /** Files the step made, over all items. */
  files: number;
  /** First error line of a failed cell ("" = none). */
  error: string;
}

export function emptyStats(): StepRunStats {
  return { pending: 0, running: 0, waiting: 0, needsYou: 0, done: 0, failed: 0, skipped: 0, files: 0, error: "" };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
}

/** The state of one step across every item of the run. */
export function stepStats(run: RunView, stepId: string): StepRunStats {
  const out: StepRunStats = { ...emptyStats(), ...stepRunCounts([run], stepId) };
  for (const it of run.items) {
    for (const c of it.cells) {
      if (c.stepId !== stepId) continue;
      if (c.status === CellStatus.CellSkipped) out.skipped++;
      out.files += c.files.length;
      if (!out.error && c.status === CellStatus.CellFailed) out.error = firstLine(c.error);
    }
  }
  return out;
}

/** Average progress (0..1) of the step's running cells, or -1 when unknown. */
export function stepProgress(run: RunView, stepId: string, progressOf: (c: RunCellView) => number): number {
  const ps: number[] = [];
  for (const it of run.items) for (const c of it.cells) if (c.stepId === stepId && c.status === CellStatus.CellRunning) ps.push(progressOf(c));
  if (ps.length === 0 || ps.some((p) => p < 0)) return -1;
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

/** "2 done · 1 running · 1 skipped"; "Not started" while nothing has begun. */
export function statsText(s: StepRunStats): string {
  const parts: string[] = [];
  if (s.needsYou > 0) parts.push(`${s.needsYou} need you`);
  if (s.running > 0) parts.push(`${s.running} running`);
  if (s.waiting > 0) parts.push(`${s.waiting} waiting`);
  if (s.done > 0) parts.push(`${s.done} done`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  if (parts.length === 0 && s.pending > 0) parts.push("Not started");
  return parts.join(" · ");
}

/** "3 files" or "" */
export function filesText(n: number): string {
  return n === 0 ? "" : `${n} ${n === 1 ? "file" : "files"}`;
}

/**
 * What the wire into a step looks like: it flows while the step works or waits,
 * glows when it's done, turns red on failure, and dims while its source has
 * passed nothing on yet.
 */
export function runWireState(from: StepRunStats | undefined, to: StepRunStats): WireVisualState {
  if (to.failed > 0) return "failed";
  if (to.running > 0 || to.waiting > 0 || to.needsYou > 0) return "flow";
  if (to.done > 0 && to.pending === 0) return "done";
  if (from && from.done === 0 && from.skipped === 0 && to.done === 0) return "dim";
  return "idle";
}

/** Step ids that wait for the user, in step order. */
export function needsYouSteps(run: RunView): string[] {
  return run.steps.filter((s) => stepStats(run, s.id).needsYou > 0).map((s) => s.id);
}

export interface StepCellRow {
  item: RunItemView;
  cell: RunCellView;
  stepIndex: number;
}

/** The cells of one step per item (merged items after their sources), without "not applicable" ones. */
export function stepCells(run: RunView, stepId: string): StepCellRow[] {
  const stepIndex = run.steps.findIndex((s) => s.id === stepId);
  const out: StepCellRow[] = [];
  for (const item of orderItems(run.items)) {
    const cell = item.cells.find((c) => c.stepId === stepId) ?? item.cells[stepIndex];
    if (!cell || cellLook(cell).label === "Not applicable") continue;
    out.push({ item, cell, stepIndex });
  }
  return out;
}

export function isNeedsYou(cell: RunCellView): boolean {
  return cell.status === CellStatus.CellWaiting && (cell.wait === WaitKind.WaitManual || cell.wait === WaitKind.WaitCheck);
}

/** The run's pipeline as a graph, laid out as the editor lays it out (columns by depth), with room under each node for its run block. */
export function runGraph(steps: readonly PipelineStep[], opts: BuildOptions = {}): Graph {
  // Read-only: the files port and the wired parameters only (no expanders, no unused outputs).
  const base = buildGraph(steps, undefined, parseLayout(""), { ...opts, compact: true });
  const heights = new Map(base.nodes.map((n) => [n.id, n.h + RUN_FOOT_H] as const));
  const pos = autoLayout(topoSort(steps), heights);
  return {
    wires: base.wires,
    nodes: base.nodes.map((n) => ({ ...n, x: pos[n.id]?.x ?? n.x, y: pos[n.id]?.y ?? n.y, h: heights.get(n.id) ?? n.h })),
  };
}

/**
 * A long chain read at 50 % is unreadable: when the columns don't fit `width`
 * at a readable zoom, wrap them into rows (left to right, then the next row),
 * so the run uses the panel's height instead of shrinking. Wires follow the
 * nodes, since they're drawn from port positions.
 */
export function wrapRunGraph(g: Graph, width: number, readableZoom = 0.85): Graph {
  if (width <= 0 || g.nodes.length === 0) return g;
  const step = NODE_W + RUN_COL_GAP;
  const colOf = (x: number) => Math.round(x / step);
  const cols = Math.max(...g.nodes.map((n) => colOf(n.x))) + 1;
  const perRow = Math.max(1, Math.floor((width / readableZoom - 48 + RUN_COL_GAP) / step));
  if (cols <= perRow) return g;
  const colHeight = new Map<number, number>();
  for (const n of g.nodes) colHeight.set(colOf(n.x), Math.max(colHeight.get(colOf(n.x)) ?? 0, n.y + n.h));
  const rows = Math.ceil(cols / perRow);
  const rowH: number[] = [];
  for (let r = 0; r < rows; r++) {
    let h = 0;
    for (let c = r * perRow; c < Math.min(cols, (r + 1) * perRow); c++) h = Math.max(h, colHeight.get(c) ?? 0);
    rowH.push(h);
  }
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((a, h) => a + h + RUN_ROW_GAP, 0));
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const c = colOf(n.x);
      const r = Math.floor(c / perRow);
      return { ...n, x: (c % perRow) * step, y: (rowY[r] ?? 0) + n.y };
    }),
  };
}

const RUN_COL_GAP = 60;
const RUN_ROW_GAP = 72;
