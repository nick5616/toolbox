/**
 * Composition helpers (Phase 10, SPEC.md §6): a variant is a tool built on a
 * base tool; parts are the tools a tool is made of. Pure functions over the
 * module descriptors, plus hooks with stable references.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
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

/**
 * What each part of a tool would be opened with (Phase 11, SPEC §4.4): a host
 * tool reports its current files per constituent ("stems" → the song), and
 * the CompositionBar's "Uses" chips open that constituent inside the host
 * (or in its own window) already loaded with them.
 */
interface CompositionInputsState {
  byHost: Record<string, Record<string, string[]>>;
  set(host: string, inputs: Record<string, string[]> | null): void;
}

const useCompositionInputsStore = create<CompositionInputsState>((set) => ({
  byHost: {},
  set: (host, inputs) =>
    set((s) => {
      const byHost = { ...s.byHost };
      if (inputs) byHost[host] = inputs;
      else delete byHost[host];
      return { byHost };
    }),
}));

const NO_INPUTS: string[] = [];

/** Host tools: report the files each part would get (`{ stems: [song], "bpm-key": [song] }`). Cleared on unmount. */
export function useCompositionInputs(host: string, inputs: Readonly<Record<string, readonly string[]>>): void {
  const key = JSON.stringify(inputs);
  useEffect(() => {
    useCompositionInputsStore.getState().set(host, JSON.parse(key) as Record<string, string[]>);
    return () => useCompositionInputsStore.getState().set(host, null);
  }, [host, key]);
}

/** The files `part` gets when opened from `host` (empty when the host reported none). */
export function useCompositionInputsFor(host: string, part: string): string[] {
  return useCompositionInputsStore((s) => s.byHost[host]?.[part] ?? NO_INPUTS);
}

/** Non-hook read (tests, commands). */
export function compositionInputs(host: string, part: string): string[] {
  return useCompositionInputsStore.getState().byHost[host]?.[part] ?? NO_INPUTS;
}
