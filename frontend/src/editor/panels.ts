/**
 * Editor panels (Phase 10, SPEC.md §5.5). CONTRACT between WP-E3 (registers
 * panels, lays out the minimal surfaces with click-ins) and WP-E4 (the part
 * windows that render a panel popped out, over the store bridge).
 *
 * A panel is one constituent surface of the editor: Media, Project, Song,
 * Captions, the clip's Transform / Effects / Masks / Cut-out / Speed / Text …
 * Inline it renders inside a <ClickIn> drawer; popped out it renders in a part
 * window ("<moduleId>.panel", params {panel: id}) against the replica store.
 * A panel reads everything from the editor store (useEditStudio, useProject,
 * selection) and the profile context — never from props — so it renders the
 * same in both places.
 */
import type { ComponentType } from "react";

export interface EditorPanel {
  /** [a-z0-9-], unique, e.g. "media", "clip-effects". */
  id: string;
  title: string;
  /** lucide icon name. */
  icon: string;
  /** One line for the launcher tooltip. */
  tip: string;
  component: ComponentType;
  /** Pop-out window size (default 380 × 720). */
  width?: number;
  height?: number;
}

const panels = new Map<string, EditorPanel>();

/** Registers (or replaces) a panel. Call at module load. */
export function registerEditorPanel(p: EditorPanel): void {
  panels.set(p.id, p);
}

export function getEditorPanel(id: string): EditorPanel | undefined {
  return panels.get(id);
}

export function listEditorPanels(): EditorPanel[] {
  return [...panels.values()];
}

/** The part id that shows one panel in its own window, for a tool. */
export const panelPartId = (moduleId: string): string => `${moduleId}.panel`;

/** The part id of a tool's live preview window. */
export const previewPartId = (moduleId: string): string => `${moduleId}.preview`;
