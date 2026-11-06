import { useMemo } from "react";
import { useModules, isReady, type ModuleView } from "@/state/modules";
import { useUI } from "@/state/ui";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "@/tools/pipelines/editorModel";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  soon?: boolean;
  /** One-line description for the tooltip. */
  tip?: string;
  /** Set on a variant listed under its base tool (the base's id). */
  variantOf?: string;
  /** The tool's `Descriptor.Category` ("" for Library, Settings…). */
  category?: string;
}

/** A sidebar group of tools under one collapsible label. */
export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/** The group for tools whose category is unknown. */
export const OTHER_GROUP = "other";

export const RECENT_ITEM: NavItem = { id: "library", label: "Library", icon: "history", tip: "Every file your tools have made, newest first, with search and quick actions" };
export const PIPELINES_ITEM: NavItem = { id: "pipelines", label: "Pipelines", icon: "workflow", tip: "Chain tools into repeatable recipes that run on files, folders or a schedule" };
export const SETTINGS_ITEM: NavItem = { id: "settings", label: "Settings", icon: "settings", tip: "Library folder, tool packs, shortcuts, appearance and dependencies" };

function toItem(m: ModuleView): NavItem {
  const soon = !isReady(m);
  const base = m.tagline || m.description;
  const tip = soon ? (base ? `${base} (coming soon)` : "Coming soon") : base;
  return { id: m.id, label: m.name, icon: m.icon, soon, category: m.category, ...(tip ? { tip } : {}) };
}

/** Visible modules (non-hidden), ordered by descriptor order. */
export function useVisibleModules(): ModuleView[] {
  const list = useModules((s) => s.list);
  return useMemo(() => list.filter((m) => !m.hidden).sort((a, b) => a.order - b.order), [list]);
}

export interface NavGroups {
  /** Every ready tool in group order, variants right after their base. */
  tools: NavItem[];
  soon: NavItem[];
  /** The tools Mod+1..9 open, in digit order: pinned first, then the first shown. */
  ordered: NavItem[];
  /** Pinned tools, in pin order. */
  pinned: NavItem[];
  /** Recently used tools (not pinned), newest first. */
  recent: NavItem[];
  /** Tools by category (empty groups left out). */
  groups: NavGroup[];
  /** Mod+digit of each tool in `ordered` (1..9). */
  digits: Record<string, number>;
}

/** Groups tools by category in the Pipelines palette's order; variants follow their base. */
export function groupTools(ready: NavItem[]): NavGroup[] {
  const byCat = new Map<string, NavItem[]>();
  const catOf = new Map<string, string>();
  for (const it of ready) {
    const known = it.category && CATEGORY_LABELS[it.category] ? it.category : OTHER_GROUP;
    const cat = it.variantOf ? (catOf.get(it.variantOf) ?? known) : known;
    catOf.set(it.id, cat);
    const list = byCat.get(cat) ?? [];
    list.push(it);
    byCat.set(cat, list);
  }
  const groups: NavGroup[] = [];
  for (const c of CATEGORY_ORDER) {
    const items = byCat.get(c);
    if (items?.length) groups.push({ id: c, label: CATEGORY_LABELS[c] ?? c, items });
  }
  const other = byCat.get(OTHER_GROUP);
  if (other?.length) groups.push({ id: OTHER_GROUP, label: groups.length ? "Other tools" : "Tools", items: other });
  return groups;
}

/** Pure part of useNavGroups (tested). */
export function buildNavGroups(modules: ModuleView[], pinnedIds: readonly string[], recentIds: readonly string[]): NavGroups {
  // Pipelines is its own item, not a tool (SPEC.md §11.1).
  const ready = modules.filter((m) => isReady(m) && m.id !== PIPELINES_ITEM.id);
  const readyIds = new Set(ready.map((m) => m.id));
  // A variant nests under its base when the base is a listed (ready, visible) baseline.
  const nestedUnder = (m: ModuleView) => (m.base && readyIds.has(m.base) && !ready.find((b) => b.id === m.base)?.base ? m.base : "");
  const flat: NavItem[] = [];
  for (const m of ready) {
    if (nestedUnder(m)) continue;
    flat.push(toItem(m));
    for (const v of ready) if (nestedUnder(v) === m.id) flat.push({ ...toItem(v), variantOf: m.id });
  }
  const groups = groupTools(flat);
  const tools = groups.flatMap((g) => g.items);
  const byId = new Map(tools.map((t) => [t.id, t]));
  const pinned = pinnedIds.map((id) => byId.get(id)).filter((t): t is NavItem => !!t);
  const pinnedSet = new Set(pinned.map((p) => p.id));
  const recent = recentIds.map((id) => byId.get(id)).filter((t): t is NavItem => !!t && !pinnedSet.has(t.id));
  const ordered = [...pinned, ...tools.filter((t) => !pinnedSet.has(t.id))].slice(0, 9);
  const digits: Record<string, number> = {};
  ordered.forEach((t, i) => (digits[t.id] = i + 1));
  const soon = modules.filter((m) => !isReady(m)).map(toItem);
  return { tools, soon, ordered, pinned, recent, groups, digits };
}

export function useNavGroups(): NavGroups {
  const modules = useVisibleModules();
  const pinned = useUI((s) => s.pinned);
  const recentTools = useUI((s) => s.recentTools);
  return useMemo(() => buildNavGroups(modules, pinned, recentTools), [modules, pinned, recentTools]);
}

/** Human title of a view id. */
export function viewTitle(view: string, byId: Record<string, ModuleView>): string {
  if (view === "library") return "Library";
  if (view === "settings") return "Settings";
  if (view === "pipelines") return "Pipelines";
  if (view === "gallery") return "Component gallery";
  return byId[view]?.name ?? view;
}
