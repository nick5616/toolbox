import { useMemo } from "react";
import { create } from "zustand";
import { DesktopService } from "@/lib/api";
import { on } from "@/lib/events";
import { toolWindowKey } from "@/lib/windows";
import type { ModuleView } from "./modules";

interface WindowsState {
  /** Keys of the open pop-out windows ("tool:<id>", "part:<id>[@n]"). */
  open: string[];
  setOpen: (open: string[]) => void;
}

export const useWindows = create<WindowsState>((set, get) => ({
  open: [],
  setOpen: (open) => {
    const cur = get().open;
    if (cur.length === open.length && cur.every((k, i) => k === open[i])) return;
    set({ open });
  },
}));

/** Loads the open windows once (bootstrap). */
export async function loadWindows(): Promise<void> {
  const open = await DesktopService.OpenWindows();
  useWindows.getState().setOpen(open ?? []);
}

/** Keeps the store in step with `windows:changed`. Returns the unsubscribe. */
export function subscribeWindows(): () => void {
  return on("windows:changed", (p) => useWindows.getState().setOpen(p.open ?? []));
}

/** Whether the pop-out with this key is open. */
export function useWindowOpen(key: string): boolean {
  return useWindows((s) => s.open.includes(key));
}

/** The tools that share one document with `moduleId`: its base and every variant of that base. Includes `moduleId`. */
export function toolFamily(moduleId: string, byId: Record<string, Pick<ModuleView, "id" | "base">>): string[] {
  const root = byId[moduleId]?.base || moduleId;
  const ids = new Set<string>([moduleId, root]);
  for (const m of Object.values(byId)) if (m.id === root || m.base === root) ids.add(m.id);
  return [...ids];
}

const sharedStoreFamilies: string[][] = [];

/**
 * Registers tools that share one store, so they can't be in two windows at
 * once: popping out one shows the placeholder for the others in the main
 * window (Phase 11 §4.4). Tools that merely build on each other (Subtitles on
 * Transcribe) keep independent windows.
 */
export function registerSharedStoreFamily(ids: readonly string[]): void {
  const key = [...ids].sort().join("|");
  if (sharedStoreFamilies.some((f) => [...f].sort().join("|") === key)) return;
  sharedStoreFamilies.push([...ids]);
}

/** The tools that share a store with `moduleId` (itself included); just `[moduleId]` when it shares none. */
export function sharedStoreFamily(moduleId: string): string[] {
  const group = sharedStoreFamilies.find((f) => f.includes(moduleId));
  return group ? [...new Set([moduleId, ...group])] : [moduleId];
}

// The Video Editor and Edit Studio edit one document through one store.
registerSharedStoreFamily(["video-studio", "edit-studio"]);

/** The key of the open window that holds this tool or a tool sharing its store (video-studio ⇔ edit-studio), else null. */
export function openToolWindow(moduleId: string, open: string[]): string | null {
  for (const id of sharedStoreFamily(moduleId)) {
    const k = toolWindowKey(id);
    if (open.includes(k)) return k;
  }
  return null;
}

/** Family-aware: the key of the tool window this tool lives in right now, or null while it's in the main window. */
export function useToolPoppedOut(moduleId: string): string | null {
  const open = useWindows((s) => s.open);
  return useMemo(() => openToolWindow(moduleId, open), [moduleId, open]);
}
