import { useMemo } from "react";
import { useModules, isReady, type ModuleView } from "@/state/modules";
import { useUI } from "@/state/ui";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  soon?: boolean;
}

export const RECENT_ITEM: NavItem = { id: "library", label: "Recent", icon: "history" };
export const SETTINGS_ITEM: NavItem = { id: "settings", label: "Settings", icon: "settings" };

function toItem(m: ModuleView): NavItem {
  return { id: m.id, label: m.name, icon: m.icon, soon: !isReady(m) };
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
    const tools = modules.filter(isReady).map(toItem);
    const soon = modules.filter((m) => !isReady(m)).map(toItem);
    return { tools, soon, ordered: [RECENT_ITEM, ...tools, ...(comingSoonOpen ? soon : [])] };
  }, [modules, comingSoonOpen]);
}

/** Human title of a view id. */
export function viewTitle(view: string, byId: Record<string, ModuleView>): string {
  if (view === "library") return "Recent";
  if (view === "settings") return "Settings";
  if (view === "gallery") return "Component gallery";
  return byId[view]?.name ?? view;
}
