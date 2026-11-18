import { lazy, Suspense, useEffect } from "react";
import { finishLibraryPick, registerLibraryPickerHost, useLibraryPick } from "./pick";

// Loaded on first use, so the dialog stays out of start-up JS.
const LibraryPickerDialog = lazy(() => import("./LibraryPickerDialog").then((m) => ({ default: m.LibraryPickerDialog })));

/** Shows pickFromLibrary() requests. Mount once per window (the shells do). */
export function LibraryPickerHost() {
  const req = useLibraryPick((s) => s.req);
  useEffect(() => registerLibraryPickerHost(), []);
  if (!req) return null;
  const id = req.id;
  return (
    <Suspense fallback={null}>
      <LibraryPickerDialog key={id} {...req.opts} onAdd={(paths) => finishLibraryPick(id, paths)} onClose={() => finishLibraryPick(id, [])} />
    </Suspense>
  );
}
