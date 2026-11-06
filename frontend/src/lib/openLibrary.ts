/**
 * Opens the Library at a tool, file or output (Phase 19, SPEC §3.4): sets the
 * view, the tool filter and the selection, then switches to the Library.
 * Used by every tool's header ("Show in Library"), completion toasts and
 * Paint+'s Exports. Main window only: a tool window has no Library view.
 */
import { useLibrary, type LibraryTarget } from "@/state/library";
import { useUI } from "@/state/ui";

export type { LibraryTarget };

export function openLibrary(target: LibraryTarget = {}): void {
  useLibrary.getState().applyLink(target);
  useUI.getState().navigate("library");
}
