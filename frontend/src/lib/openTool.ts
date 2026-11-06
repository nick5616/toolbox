/**
 * Opening another tool (a constituent) with inputs (Phase 10, SPEC.md §7).
 * One helper for every "open this in <tool>" action, so each can also open
 * the tool in its own window.
 *
 * - In the main window without `window`: a normal handoff (navigates there).
 * - With `window: true`, or from any pop-out window: the tool opens in its
 *   own window and takes the handoff there (`DesktopService.PopOut` keeps it
 *   for the new window's `TakeHandoff`).
 */
import { toast } from "@/components/toast";
import { toAppError } from "@/lib/errors";
import { currentWindow, popOutTool } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI, type Handoff } from "@/state/ui";

export interface OpenToolOptions {
  /** Open in the tool's own window. */
  window?: boolean;
}

/** Opens `moduleId`, handing it `inputs` (and any extra handoff fields). */
export async function openTool(moduleId: string, inputs: string[] = [], extra: Omit<Handoff, "moduleId" | "inputs"> = {}, o: OpenToolOptions = {}): Promise<void> {
  const handoff: Handoff = { moduleId, inputs, ...extra };
  const inWindow = o.window === true || currentWindow().kind !== "main";
  if (!inWindow) {
    if (inputs.length > 0 || Object.keys(extra).length > 0) useUI.getState().handOff(handoff);
    else useUI.getState().navigate(moduleId);
    return;
  }
  const name = useModules.getState().byId[moduleId]?.name ?? moduleId;
  try {
    await popOutTool(moduleId, { title: `${name} — Toolbox`, handoff: inputs.length > 0 || Object.keys(extra).length > 0 ? handoff : undefined });
  } catch (e) {
    toast({ tone: "danger", title: toAppError(e).message });
  }
}

/**
 * Menu items for "Open in <tool>" plus "…in its own window", for any tool
 * that hands files to another (Library, editors, composites).
 */
export function openToolItems(moduleId: string, inputs: string[], idPrefix = "open", action?: string): { id: string; label: string; tip: string; onSelect: () => void }[] {
  const name = useModules.getState().byId[moduleId]?.name ?? moduleId;
  return [
    { id: `${idPrefix}-${moduleId}`, label: `Open in ${name}`, tip: `Send to ${name}`, onSelect: () => void openTool(moduleId, inputs, action ? { action } : {}) },
    { id: `${idPrefix}-${moduleId}-window`, label: `Open in ${name} (new window)`, tip: `Open ${name} in its own window with this`, onSelect: () => void openTool(moduleId, inputs, action ? { action } : {}, { window: true }) },
  ];
}
