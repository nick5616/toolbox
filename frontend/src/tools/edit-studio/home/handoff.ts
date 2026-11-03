/**
 * Handoffs and page drops for Edit Studio (Phase 9 SPEC §14.13). The shell's
 * drop routing already turns a drop on this tool's page (or its drop zone)
 * into a `useUI` handoff, so both arrive here.
 */
import { useEffect, useRef } from "react";
import { toast } from "@/components";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { acceptsPath } from "@/tools/_kit/accepts";
import { addSourcePaths } from "../sources/actions";
import { useEditStudio } from "../store";
import { AUDIO_EXTENSIONS } from "../transport/logic";
import { useAsSong } from "./createEdit";
import { useNewEditRequest } from "./newEditRequest";

const MEDIA = [".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp", ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"];

export interface ClassifiedInputs {
  /** Audio files (a song). */
  audio: string[];
  /** Videos and photos (Sources). */
  media: string[];
  ignored: string[];
}

/** Splits dropped paths into songs, sources and what the tool can't use. */
export function classifyInputs(inputs: readonly string[]): ClassifiedInputs {
  const out: ClassifiedInputs = { audio: [], media: [], ignored: [] };
  for (const p of inputs) {
    if (acceptsPath(AUDIO_EXTENSIONS, p)) out.audio.push(p);
    else if (acceptsPath(MEDIA, p)) out.media.push(p);
    else out.ignored.push(p);
  }
  return out;
}

/**
 * What to do with inputs: with an edit open, videos and photos join its
 * Sources and an audio file offers to become the song (set at once when the
 * edit has none); with none open, the New edit dialog opens with the song
 * and the queued sources.
 */
export async function routeInputs(inputs: readonly string[]): Promise<void> {
  const { audio, media, ignored } = classifyInputs(inputs);
  if (ignored.length) toast({ title: `Skipped ${ignored.length} unsupported ${ignored.length === 1 ? "file" : "files"}`, tone: "warn" });
  const st = useEditStudio.getState();
  const song = audio[0];
  if (!st.projectId) {
    if (song || media.length) useNewEditRequest.getState().request({ ...(song ? { song } : {}), sources: media });
    return;
  }
  try {
    if (media.length) await addSourcePaths(media);
    if (song) {
      if (st.history?.present.song) useNewEditRequest.getState().askSong(song);
      else await useAsSong(song);
    }
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/**
 * Takes `useUI().takeHandoff(moduleId)` handoffs and files dropped on the page:
 * an audio file starts a new edit (or offers to replace the song); videos and
 * photos go to the open edit's Sources. `open` opens a project by ID.
 */
export function useEditHandoff(moduleId: string, open: (id: string) => void): void {
  const handoff = useUI((s) => s.handoff);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (!h) return;
    void routeInputs(h.inputs);
  }, [handoff, moduleId]);
}
