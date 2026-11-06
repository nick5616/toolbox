/**
 * Paint+'s keyboard actions (SPEC §1.1 item 16). One table feeds the key
 * binding (`useShortcut`) and the "?" overlay (`useCommands`), so they never
 * drift apart.
 */
import type { PaintEngine } from "@/paint/engine/types";
import { usePaintUI, type PanelId, type ToolId } from "./store";
import type { EditorDialog } from "./context";

export interface EditorAction {
  id: string;
  title: string;
  /** Combo in lib/shortcuts syntax ("Mod+Shift+Z", "["). */
  combo: string;
  run(): void;
}

export interface ActionCtx {
  engine: PaintEngine;
  openDialog(d: EditorDialog): void;
  toggleStudio(): void;
  toggleHide(): void;
  togglePanel(p: PanelId): void;
  flashHud(): void;
}

export const SIZE_STEP = 1.12;

export const nextSize = (px: number, dir: 1 | -1): number => {
  const n = dir === 1 ? Math.max(px + 1, Math.round(px * SIZE_STEP)) : Math.min(px - 1, Math.round(px / SIZE_STEP));
  return Math.max(1, Math.min(400, n));
};

export function buildActions(c: ActionCtx): EditorAction[] {
  const ui = () => usePaintUI.getState();
  const tool = (id: string, title: string, combo: string, t: ToolId): EditorAction => ({
    id: `paint.tool.${id}`,
    title,
    combo,
    run: () => {
      ui().setTool(t);
      if (t === "transform" && !c.engine.transform.active) c.engine.transform.begin("free");
    },
  });
  const active = () => c.engine.doc.active;
  const all = () => c.engine.selection.rect({ x: 0, y: 0, w: c.engine.doc.width, h: c.engine.doc.height });
  return [
    tool("brush", "Brush", "B", "brush"),
    tool("eraser", "Eraser", "E", "eraser"),
    tool("smudge", "Smudge", "S", "smudge"),
    tool("fill", "Fill", "G", "fill"),
    tool("transform", "Transform", "V", "transform"),
    tool("lasso", "Lasso select", "L", "lasso"),
    tool("rect", "Rectangle select", "M", "rect"),
    tool("wand", "Magic wand", "W", "wand"),
    tool("eyedropper", "Eyedropper", "I", "eyedropper"),
    { id: "paint.size.up", title: "Bigger brush", combo: "]", run: () => (ui().setSize(nextSize(ui().size, 1)), c.flashHud()) },
    { id: "paint.size.down", title: "Smaller brush", combo: "[", run: () => (ui().setSize(nextSize(ui().size, -1)), c.flashHud()) },
    { id: "paint.opacity.up", title: "More opacity", combo: "}", run: () => (ui().setOpacity(Math.min(1, ui().opacity + 0.05)), c.flashHud()) },
    { id: "paint.opacity.down", title: "Less opacity", combo: "{", run: () => (ui().setOpacity(Math.max(0.01, ui().opacity - 0.05)), c.flashHud()) },
    { id: "paint.undo", title: "Undo", combo: "Mod+Z", run: () => void c.engine.undo() },
    { id: "paint.redo", title: "Redo", combo: "Mod+Shift+Z", run: () => void c.engine.redo() },
    { id: "paint.redo2", title: "Redo", combo: "Mod+Y", run: () => void c.engine.redo() },
    { id: "paint.select.all", title: "Select all", combo: "Mod+A", run: all },
    { id: "paint.select.none", title: "Deselect", combo: "Mod+D", run: () => c.engine.selection.clear() },
    { id: "paint.select.invert", title: "Invert selection", combo: "Mod+Shift+I", run: () => c.engine.selection.invert() },
    { id: "paint.layer.duplicate", title: "Duplicate layer", combo: "Mod+J", run: () => void c.engine.duplicateLayer(active()) },
    { id: "paint.layer.merge", title: "Merge layer down", combo: "Mod+E", run: () => c.engine.mergeDown(active()) },
    { id: "paint.hide", title: "Hide or show the interface", combo: "Tab", run: c.toggleHide },
    { id: "paint.studio", title: "Studio mode", combo: "F", run: c.toggleStudio },
    { id: "paint.color", title: "Colour panel", combo: "C", run: () => c.togglePanel("color") },
    { id: "paint.export", title: "Export", combo: "Mod+Shift+E", run: () => c.openDialog("export") },
    { id: "paint.view.fit", title: "Fit canvas to window", combo: "0", run: () => c.engine.view.fit() },
    { id: "paint.view.actual", title: "Actual size (100%)", combo: "1", run: () => c.engine.view.actual() },
    { id: "paint.view.in", title: "Zoom in", combo: "=", run: () => c.engine.view.set({ zoom: c.engine.view.get().zoom * 1.25 }) },
    { id: "paint.view.out", title: "Zoom out", combo: "-", run: () => c.engine.view.set({ zoom: c.engine.view.get().zoom / 1.25 }) },
  ];
}

/** Combos the key handler listens for. */
export const actionCombos = (actions: EditorAction[]): string[] => actions.map((a) => a.combo);
