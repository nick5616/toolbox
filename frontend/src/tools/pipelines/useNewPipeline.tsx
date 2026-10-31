import type { ReactNode } from "react";

// STUB (Wave 0): WP-UI1 implements the template gallery (SPEC.md §11.2).
// Returns the dialog element to render and a function that opens it.
export function useNewPipeline(): { open: () => void; dialog: ReactNode } {
  return { open: () => undefined, dialog: null };
}
