/**
 * Reports what each part of the editor would get, so the CompositionBar's
 * "Uses" chips open those tools with the right file (Phase 11 SPEC §6).
 */
import { useMemo } from "react";
import { useCompositionInputs } from "@/state/composition";
import { findClip } from "../doc";
import type { EditorProfile } from "../profile";
import { useEditStudio } from "../store";

const NONE: string[] = [];

/** The inputs per part for the current song and selected clip (kind and path; "" when none). */
export function compositionFor(profile: Pick<EditorProfile, "song">, song: string, clipKind: string, clipPath: string): Record<string, string[]> {
  const clip = clipPath ? [clipPath] : NONE;
  const songs = song ? [song] : NONE;
  const out: Record<string, string[]> = {
    "bg-remover": clipKind === "image" ? clip : NONE,
    upscaler: clipKind === "image" ? clip : NONE,
    "audio-cleanup": clipKind === "video" ? clip : NONE,
    stems: songs,
  };
  if (profile.song === "analyzed") {
    out.visualizer = songs;
    out.transcribe = songs;
    out["bpm-key"] = songs;
  }
  return out;
}

export function useEditorComposition(profile: EditorProfile): void {
  const song = useEditStudio((s) => s.history?.present.song?.path ?? "");
  const clip = useEditStudio((s) => {
    const doc = s.history?.present;
    const sl = s.selection;
    if (!doc || sl?.kind !== "clips" || sl.ids.length !== 1) return "";
    const c = findClip(doc, sl.ids[0] as string)?.clip;
    return c ? `${c.kind}|${c.path}` : "";
  });
  const inputs = useMemo(() => {
    const i = clip.indexOf("|");
    return compositionFor(profile, song, i < 0 ? "" : clip.slice(0, i), i < 0 ? "" : clip.slice(i + 1));
  }, [profile, song, clip]);
  useCompositionInputs(profile.moduleId, inputs);
}
