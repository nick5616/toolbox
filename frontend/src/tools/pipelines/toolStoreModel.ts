import { ModuleStatus, type StepType } from "@/lib/api";
import type { ModuleView } from "@/state/modules";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "./editorModel";

// The tool store's contents (SPEC.md §12): every step type of the catalogue by
// group, plus the tools that can't be steps, with the reason.

export interface StoreTool {
  type: StepType;
}

export interface StoreGroup {
  id: string;
  label: string;
  tools: StepType[];
}

export interface UnavailableTool {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  reason: string;
}

export interface StoreContents {
  groups: StoreGroup[];
  unavailable: UnavailableTool[];
}

/** Why a tool of the app can't be a pipeline step. */
export function unavailableReason(m: ModuleView): string {
  if (m.status !== ModuleStatus.StatusReady) return "Not built yet";
  if (m.jobLess) return "It works live and doesn't run jobs, so a pipeline can't use it";
  const a = m.accepts;
  if (!a.urls && !a.any && a.extensions.length === 0) return "It doesn't take files, so there is nothing to feed it";
  return "It edits a project by hand rather than turning files into files";
}

function matches(q: string, ...texts: string[]): boolean {
  return q === "" || texts.some((t) => t.toLowerCase().includes(q));
}

/** The store for a search query: glue first, then tools by category, then what isn't available. */
export function storeContents(catalog: readonly StepType[], modules: readonly ModuleView[], query: string): StoreContents {
  const q = query.trim().toLowerCase();
  const visible = catalog.filter((t) => matches(q, t.name, t.description));
  const groups: StoreGroup[] = [];
  const glue = visible.filter((t) => t.builtin);
  if (glue.length > 0) groups.push({ id: "glue", label: "Glue & flow", tools: glue });
  const tools = visible.filter((t) => !t.builtin);
  const cats = [...CATEGORY_ORDER, ...tools.map((t) => t.category as string)].filter((c, i, a) => a.indexOf(c) === i);
  for (const c of cats) {
    const list = tools.filter((t) => t.category === c);
    if (list.length > 0) groups.push({ id: c, label: CATEGORY_LABELS[c] ?? c, tools: list });
  }
  const inCatalog = new Set(catalog.map((t) => t.moduleId).filter(Boolean));
  const unavailable = modules
    .filter((m) => !m.hidden && m.id !== "pipelines" && !inCatalog.has(m.id))
    .filter((m) => matches(q, m.name, m.tagline))
    .map((m) => ({ id: m.id, name: m.name, icon: m.icon, tagline: m.tagline, reason: unavailableReason(m) }));
  return { groups, unavailable };
}
