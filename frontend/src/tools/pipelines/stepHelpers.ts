import type { PipelineStep, StepProduct, StepType } from "@/lib/api";
import type { Filter } from "./editorModel";

// Small pure helpers shared by StepCard (list view) and StepOptions (list + graph).

/** The step's own label, else its type's name. */
export function stepName(step: PipelineStep, type: StepType | undefined): string {
  return step.label.trim() || type?.name || step.type;
}

/** Roles a source step makes (deduplicated, with labels). */
export function roleProducts(products: readonly StepProduct[]): Array<{ role: string; label: string }> {
  const out: Array<{ role: string; label: string }> = [];
  for (const p of products) if (p.role && !out.some((o) => o.role === p.role)) out.push({ role: p.role, label: p.label || p.role });
  return out;
}

export function filterText(f: Filter, roles: ReadonlyArray<{ role: string; label: string }>): string {
  const parts: string[] = [];
  if (f.roles.length > 0) parts.push(f.roles.map((r) => roles.find((x) => x.role === r)?.label ?? r).join(", "));
  if (f.kinds.length > 0) parts.push(f.kinds.join(", "));
  if (f.exts.length > 0) parts.push(f.exts.join(", "));
  const base = parts.length > 0 ? `${parts.join(" · ")} only` : "";
  if (f.name.trim()) return [base, `name has “${f.name.trim()}”`].filter(Boolean).join(" · ");
  return base;
}
