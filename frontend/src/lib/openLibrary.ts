/**
 * Opens the Library at a tool, file or output (Phase 19, SPEC §3.4).
 * CONTRACT STUB (Wave 0): L2 implements the view, filter and selection.
 * Today it only switches to the Library view.
 */
import { useUI } from "@/state/ui";

export interface LibraryTarget {
  /** Filter to one tool's results. */
  moduleId?: string;
  /** Select a file (output or unregistered library file). */
  path?: string;
  outputId?: string;
}

export function openLibrary(target: LibraryTarget = {}): void {
  void target;
  useUI.getState().navigate("library");
}
