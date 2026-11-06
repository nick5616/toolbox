/**
 * In-app drag and drop (Phase 14, SPEC §1.B): every file row is a drag
 * source, and every drop target that takes OS file drops takes these too.
 *
 * - Files: `startPathsDrag(e, paths)` on `dragstart`. The data travels as
 *   `PATHS_MIME` (JSON string[]) plus `text/uri-list` (file:// URLs) so other
 *   web targets understand it.
 * - Tools: `startToolDrag(e, moduleId)` (a sidebar tool dragged onto the
 *   pipeline graph adds that step).
 *
 * Drop side: the shell routes an in-app drop on any `[data-file-drop-target]`
 * element exactly like an OS file drop on it (`shell/dropRouting.ts`), so
 * DropZones (`id="tool-drop:<module>"`), sidebar tools and pipeline cards
 * need nothing more. Custom targets read `readPaths(e)` / `readTool(e)`.
 */
import type { DragEvent as ReactDragEvent } from "react";

export const PATHS_MIME = "application/x-toolbox-paths";
export const TOOL_MIME = "application/x-toolbox-tool";

type AnyDragEvent = DragEvent | ReactDragEvent;

function dt(e: AnyDragEvent): DataTransfer | null {
  return e.dataTransfer ?? null;
}

const fileUrl = (p: string): string => "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");

/** Marks a drag as carrying these files (no-op for an empty list). */
export function startPathsDrag(e: AnyDragEvent, paths: readonly string[]): void {
  const d = dt(e);
  if (!d || paths.length === 0) return;
  d.setData(PATHS_MIME, JSON.stringify(paths));
  d.setData("text/uri-list", paths.map(fileUrl).join("\r\n"));
  d.setData("text/plain", paths.join("\n"));
  d.effectAllowed = "copy";
}

/** Marks a drag as carrying a tool (by module id). */
export function startToolDrag(e: AnyDragEvent, moduleId: string): void {
  const d = dt(e);
  if (!d) return;
  d.setData(TOOL_MIME, moduleId);
  d.setData("text/plain", moduleId);
  d.effectAllowed = "copy";
}

/** Whether the drag carries in-app files (readable during dragover: types only). */
export function hasPaths(e: AnyDragEvent): boolean {
  return !!dt(e)?.types.includes(PATHS_MIME);
}

/** Whether the drag carries a tool. */
export function hasTool(e: AnyDragEvent): boolean {
  return !!dt(e)?.types.includes(TOOL_MIME);
}

/** The files of an in-app drag (on drop), or null. */
export function readPaths(e: AnyDragEvent): string[] | null {
  const raw = dt(e)?.getData(PATHS_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  } catch {
    return null;
  }
}

/** The tool of an in-app tool drag (on drop), or null. */
export function readTool(e: AnyDragEvent): string | null {
  return dt(e)?.getData(TOOL_MIME) || null;
}
