/**
 * Composition helpers (Phase 10, SPEC.md §6): a variant is a tool built on a
 * base tool; parts are the tools a tool is made of. Pure functions over the
 * module descriptors, plus hooks with stable references.
 */
import { useMemo } from "react";
import { useModules, type ModuleView } from "./modules";

const byOrder = (a: ModuleView, b: ModuleView) => a.order - b.order;

/** Visible modules whose base is `id`, in descriptor order. */
export function variantsOf(id: string, modules: readonly ModuleView[]): ModuleView[] {
  return modules.filter((m) => m.base === id && !m.hidden).sort(byOrder);
}

/** The base module of `id`, when it has one that exists. */
export function baseOf(id: string, modules: readonly ModuleView[]): ModuleView | undefined {
  const base = modules.find((m) => m.id === id)?.base;
  return base ? modules.find((m) => m.id === base) : undefined;
}

/** The base followed by all its visible variants (for a baseline: itself + its variants). */
export function familyOf(id: string, modules: readonly ModuleView[]): ModuleView[] {
  const root = baseOf(id, modules) ?? modules.find((m) => m.id === id);
  if (!root) return [];
  return [root, ...variantsOf(root.id, modules)];
}

/** The tools `id` is built from (hidden ones included), in the descriptor's display order. */
export function partsOf(id: string, modules: readonly ModuleView[]): ModuleView[] {
  const parts = modules.find((m) => m.id === id)?.parts ?? [];
  const out: ModuleView[] = [];
  for (const pid of parts) {
    const m = modules.find((x) => x.id === pid);
    if (m) out.push(m);
  }
  return out;
}

export function useVariants(id: string): ModuleView[] {
  const list = useModules((s) => s.list);
  return useMemo(() => variantsOf(id, list), [id, list]);
}

export function useBase(id: string): ModuleView | undefined {
  const list = useModules((s) => s.list);
  return useMemo(() => baseOf(id, list), [id, list]);
}

export function useFamily(id: string): ModuleView[] {
  const list = useModules((s) => s.list);
  return useMemo(() => familyOf(id, list), [id, list]);
}

export function useParts(id: string): ModuleView[] {
  const list = useModules((s) => s.list);
  return useMemo(() => partsOf(id, list), [id, list]);
}
