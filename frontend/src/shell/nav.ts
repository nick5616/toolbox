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
    const tools = modules.filter((m) => isReady(m) && m.id !== PIPELINES_ITEM.id).map(toItem);
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
