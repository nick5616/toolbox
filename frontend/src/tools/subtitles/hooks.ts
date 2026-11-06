import { useMemo } from "react";
import { activeRows, exportBlocker, useSubtitles } from "./store";
import type { CueRow } from "./logic";

/** The cues of the active track (a stable reference until they change). */
export function useRows(): CueRow[] {
  return useSubtitles(activeRows);
}

/** What blocks saving or exporting the active track, or null. */
export function useBlocker(): string | null {
  const rows = useRows();
  const maxLine = useSubtitles((s) => s.prefs.maxLineChars);
  return useMemo(() => exportBlocker(rows, maxLine), [rows, maxLine]);
}
