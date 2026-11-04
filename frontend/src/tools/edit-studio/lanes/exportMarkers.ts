/** Markers export (§5.6): CSV or JSON of the visible lanes, written into the Library by the text job. */
import { toast } from "@/components";
import { EditStudioService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { deriveMarkers } from "@/viz/edit/markers";
import { useEditStudio } from "@/editor/store";
import { flushEdit } from "@/editor/useEditAutosave";
import { buildMarkerRows } from "./laneLogic";

/** Go's MaxTextRows. */
const MAX_ROWS = 20_000;

/** Submits the text job for the visible lanes' markers of the open edit. */
export async function exportMarkers(format: "csv" | "json"): Promise<void> {
  const s0 = useEditStudio.getState();
  if (!s0.projectId || !s0.history?.present.song || !s0.analysis) return;
  await flushEdit();
  const s = useEditStudio.getState();
  const p = s.history?.present;
  const a = s.analysis;
  if (!s.projectId || !p?.song || !a) return;
  const markers = deriveMarkers(a, p.markers, { startMs: p.song.startMs, endMs: p.song.endMs });
  const rows = buildMarkerRows(markers, p, a);
  if (!rows.length) {
    toast({ title: "There are no markers to export", description: "Show a lane first.", tone: "warn" });
    return;
  }
  if (rows.length > MAX_ROWS) {
    toast({ title: `Too many markers (${rows.length.toLocaleString()})`, description: `A file holds at most ${MAX_ROWS.toLocaleString()}. Hide a lane or raise a threshold.`, tone: "warn" });
    return;
  }
  const meta = JSON.stringify({ project: s.name, song: p.song.path, startMs: p.song.startMs, endMs: p.song.endMs, fps: p.fps });
  try {
    await EditStudioService.ExportText(s.projectId, { kind: format === "csv" ? "markers-csv" : "markers-json", name: `${s.name} markers`, markers: rows, cues: null, meta });
    toast({ title: `Saving ${rows.length.toLocaleString()} markers`, description: "It will appear in your Library under Edits.", tone: "success" });
  } catch (e) {
    toast({ title: toAppError(e).message || "Couldn't save the markers", tone: "danger" });
  }
}
