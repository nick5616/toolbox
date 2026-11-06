/** SRT export (§14.9). */
import { toast } from "@/components";
import { EditStudioService } from "@/lib/api";
import { announceWhenDone } from "@/state/jobs";
import { toAppError } from "@/lib/errors";
import { flushEdit } from "@/editor/useEditAutosave";
import { useEditStudio } from "@/editor/store";
import { effectiveLines, srtCues } from "./lines";

/** Submits the text job with the open edit's caption lines inside the range. */
export async function exportSrt(): Promise<void> {
  const s = useEditStudio.getState();
  const project = s.history?.present;
  if (!s.projectId || !project) return;
  if (!project.captions) {
    toast({ title: "No captions to export", description: "Turn on Show captions in the Captions tab first.", tone: "warn" });
    return;
  }
  if (!project.song) return;
  try {
    await flushEdit();
    const now = useEditStudio.getState();
    const doc = now.history?.present ?? project;
    const song = doc.song ?? project.song;
    const lines = effectiveLines(doc.captions, now.analysis);
    const cues = srtCues(lines, song.startMs, song.endMs);
    if (!cues.length) {
      toast({ title: "No words to export", description: "There are no caption lines inside this edit's song range.", tone: "warn" });
      return;
    }
    const job = await EditStudioService.ExportText(s.projectId, {
      kind: "srt",
      name: now.name || s.name,
      markers: [],
      cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text, words: [] })),
      meta: "",
    });
    announceWhenDone(job.id);
  } catch (e) {
    toast({ title: "Couldn't export captions", description: toAppError(e).message, tone: "danger" });
  }
}
