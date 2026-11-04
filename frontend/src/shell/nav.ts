import { useMemo } from "react";
import { useModules, isReady, type ModuleView } from "@/state/modules";
import { useUI } from "@/state/ui";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  soon?: boolean;
  /** One-line description for the tooltip. */
  tip?: string;
  /** Set on a variant listed under its base tool (the base's id). */
  variantOf?: string;
}

export const RECENT_ITEM: NavItem = { id: "library", label: "Recent", icon: "history", tip: "Every file your tools have made, newest first, with search and quick actions" };
export const PIPELINES_ITEM: NavItem = { id: "pipelines", label: "Pipelines", icon: "workflow", tip: "Chain tools into repeatable recipes that run on files, folders or a schedule" };
export const SETTINGS_ITEM: NavItem = { id: "settings", label: "Settings", icon: "settings", tip: "Library folder, tool packs, shortcuts, appearance and dependencies" };

function toItem(m: ModuleView): NavItem {
  const soon = !isReady(m);
  const base = m.tagline || m.description;
  const tip = soon ? (base ? `${base} (coming soon)` : "Coming soon") : base;
  return { id: m.id, label: m.name, icon: m.icon, soon, ...(tip ? { tip } : {}) };
}

/** Visible modules (non-hidden), ordered by descriptor order. */
export function useVisibleModules(): ModuleView[] {
  const list = useModules((s) => s.list);
  return useMemo(() => list.filter((m) => !m.hidden).sort((a, b) => a.order - b.order), [list]);
}

export interface NavGroups {
  tools: NavItem[];
  soon: NavItem[];
  /** Items in sidebar order as navigable with Mod+1..9. */
  ordered: NavItem[];
}

export function useNavGroups(): NavGroups {
  const modules = useVisibleModules();
  const comingSoonOpen = useUI((s) => s.comingSoonOpen);
  return useMemo(() => {
    // Pipelines is its own item under Recent, not a tool (SPEC.md §11.1).
    const ready = modules.filter((m) => isReady(m) && m.id !== PIPELINES_ITEM.id);
    const readyIds = new Set(ready.map((m) => m.id));
    // A variant nests under its base when the base is a listed (ready, visible) baseline.
    const nestedUnder = (m: ModuleView) => (m.base && readyIds.has(m.base) && !ready.find((b) => b.id === m.base)?.base ? m.base : "");
    const tools: NavItem[] = [];
    for (const m of ready) {
      if (nestedUnder(m)) continue;
      tools.push(toItem(m));
      for (const v of ready) if (nestedUnder(v) === m.id) tools.push({ ...toItem(v), variantOf: m.id });
    }
    const soon = modules.filter((m) => !isReady(m)).map(toItem);
    return { tools, soon, ordered: [RECENT_ITEM, PIPELINES_ITEM, ...tools, ...(comingSoonOpen ? soon : [])] };
  }, [modules, comingSoonOpen]);
}

/** Human title of a view id. */
export function viewTitle(view: string, byId: Record<string, ModuleView>): string {
  if (view === "library") return "Recent";
  if (view === "settings") return "Settings";
  if (view === "pipelines") return "Pipelines";
  if (view === "gallery") return "Component gallery";
  return byId[view]?.name ?? view;
}
