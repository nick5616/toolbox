import { CellStatus, RunStatus, WaitKind, type PipelineStep } from "@/lib/api";
import type { ChipStatus } from "@/components";
import { isRunActive, type RunCellView, type RunItemView, type RunView } from "@/state/pipelines";

// Pure helpers for the Runs tab (SPEC.md §11.5).

const ACTIVE_CELL = new Set<CellStatus>([CellStatus.CellPending, CellStatus.CellPreparing, CellStatus.CellRunning, CellStatus.CellWaiting]);
const BAD_CELL = new Set<CellStatus>([CellStatus.CellFailed, CellStatus.CellCancelled, CellStatus.CellBlocked]);

export function isBadCell(c: RunCellView): boolean {
  return BAD_CELL.has(c.status);
}

/** Every cell of the item is final and none failed, was cancelled or blocked. */
export function isItemDone(item: RunItemView): boolean {
  return item.cells.every((c) => !ACTIVE_CELL.has(c.status) && !BAD_CELL.has(c.status));
}

export function isMergedItem(item: RunItemView): boolean {
  return item.merged.length > 0;
}

/** "3 of 5 files": merged items are not files. */
export function runProgress(run: RunView): { done: number; total: number } {
  const files = run.items.filter((i) => !isMergedItem(i));
  return { done: files.filter(isItemDone).length, total: files.length };
}

/** Items in grid order: merged items sit right after the last item they gather. */
export function orderItems(items: readonly RunItemView[]): RunItemView[] {
  const plain = items.filter((i) => !isMergedItem(i));
  const merged = items.filter(isMergedItem);
  const out: RunItemView[] = [];
  const placed = new Set<number>();
  for (const it of plain) {
    out.push(it);
    for (const m of merged) {
      if (placed.has(m.index)) continue;
      if (Math.max(...m.merged) === it.index) {
        out.push(m);
        placed.add(m.index);
      }
    }
  }
  // Merged items whose sources are unknown go last.
  for (const m of merged) if (!placed.has(m.index)) out.push(m);
  return out;
}

/** Active runs first, then newest. */
export function sortRuns(runs: readonly RunView[]): RunView[] {
  return [...runs].sort((a, b) => Number(isRunActive(b)) - Number(isRunActive(a)) || b.createdAt - a.createdAt);
}

export function runChip(status: RunStatus): { status: ChipStatus; label: string } {
  switch (status) {
    case RunStatus.RunRunning:
      return { status: "running", label: "Running" };
    case RunStatus.RunWaiting:
      return { status: "queued", label: "Waiting" };
    case RunStatus.RunDone:
      return { status: "done", label: "Done" };
    case RunStatus.RunPartial:
      return { status: "failed", label: "Partial" };
    case RunStatus.RunFailed:
      return { status: "failed", label: "Failed" };
    case RunStatus.RunCancelled:
      return { status: "cancelled", label: "Cancelled" };
    default:
      return { status: "queued", label: String(status) };
  }
}

export interface CellLook {
  icon: string;
  label: string;
  tone: "ok" | "danger" | "warn" | "accent" | "muted";
  spin?: boolean;
}

export function cellLook(c: RunCellView): CellLook {
  switch (c.status) {
    case CellStatus.CellDone:
      return { icon: "circle-check", label: "Done", tone: "ok" };
    case CellStatus.CellFailed:
      return { icon: "circle-x", label: "Failed", tone: "danger" };
    case CellStatus.CellCancelled:
      return { icon: "circle-x", label: "Cancelled", tone: "muted" };
    case CellStatus.CellBlocked:
      return { icon: "circle-minus", label: "Blocked", tone: "muted" };
    case CellStatus.CellSkipped:
      return { icon: "skip-forward", label: "Skipped", tone: "muted" };
    case CellStatus.CellMerged:
      return { icon: "merge", label: "Gathered", tone: "muted" };
    case CellStatus.CellWaiting:
      return c.wait === WaitKind.WaitManual || c.wait === WaitKind.WaitCheck
        ? { icon: "hand", label: "Needs you", tone: "accent" }
        : { icon: "circle-pause", label: "Waiting", tone: "warn" };
    case CellStatus.CellRunning:
    case CellStatus.CellPreparing:
      return { icon: "loader-circle", label: c.status === CellStatus.CellRunning ? "Running" : "Preparing", tone: "accent", spin: true };
    case CellStatus.CellPending:
      return { icon: "clock", label: "Pending", tone: "muted" };
    default:
      return { icon: "minus", label: "Not applicable", tone: "muted" };
  }
}

export function stepName(step: PipelineStep, toolName: string): string {
  return step.label || toolName;
}

/** Temporary, still-existing files left in a run. */
export function hasTemporaryFiles(run: RunView): boolean {
  if (run.cleaned) return false;
  return run.items.some((i) => i.cells.some((c) => c.files.some((f) => f.temporary && !f.missing)));
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
