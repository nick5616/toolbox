/**
 * "From Library…" for Subtitles: the in-app counterpart of the native pickers
 * in `store.ts` (`pickMedia` / `pickSubtitleFile`). A pick goes through the same
 * store actions as a native one (`takeMedia`, `openSubtitleFile`), which a
 * replica window forwards to the main window.
 */
import { FromLibraryButton, pickFromLibrary, type FromLibraryButtonProps } from "@/blocks/library-picker";
import { useModules } from "@/state/modules";
import { MODULE_ID, SUBTITLE_EXTS, useSubtitles } from "./store";

type ButtonLook = Pick<FromLibraryButtonProps, "size" | "variant" | "iconOnly" | "collapsible" | "disabled" | "label">;

/** The video and audio extensions the tool takes (subtitle files are picked separately); null = any. */
export function mediaExts(): string[] | null {
  const accepted = useModules.getState().byId[MODULE_ID]?.accepts.extensions;
  const exts = (accepted ?? []).filter((e) => !SUBTITLE_EXTS.includes(e.toLowerCase()));
  return exts.length > 0 ? exts : null;
}

/** Choose a video or audio file from the Library and make it the media (resolves true when one was chosen). */
export async function pickMediaFromLibrary(): Promise<boolean> {
  const have = useSubtitles.getState().mediaPath;
  const paths = await pickFromLibrary({ title: "Choose a video or audio file from Library", exts: mediaExts(), multiple: false, have: have ? [have] : undefined });
  if (!paths[0]) return false;
  useSubtitles.getState().takeMedia(paths[0]);
  return true;
}

/** Choose an .srt or .vtt from the Library (Transcribe and Subtitles write them there) and open it for editing. */
export async function pickSubtitleFromLibrary(): Promise<boolean> {
  const paths = await pickFromLibrary({ title: "Choose a subtitle file from Library", exts: SUBTITLE_EXTS, multiple: false });
  if (!paths[0]) return false;
  useSubtitles.getState().openSubtitleFile(paths[0]);
  return true;
}

export function MediaFromLibraryButton(props: ButtonLook) {
  const have = useSubtitles((s) => s.mediaPath);
  return (
    <FromLibraryButton
      {...props}
      title="Choose a video or audio file from Library"
      label={props.label ?? "Video from Library…"}
      exts={mediaExts()}
      multiple={false}
      have={have ? [have] : undefined}
      onPick={(paths) => useSubtitles.getState().takeMedia(paths[0] ?? "")}
      tip="Use a video or audio file Toolbox already made (the Library)"
    />
  );
}

export function SubtitleFromLibraryButton(props: ButtonLook) {
  return (
    <FromLibraryButton
      {...props}
      title="Choose a subtitle file from Library"
      label={props.label ?? "Subtitles from Library…"}
      exts={SUBTITLE_EXTS}
      multiple={false}
      onPick={(paths) => useSubtitles.getState().openSubtitleFile(paths[0] ?? "")}
      tip="Open an .srt or .vtt Toolbox already made, such as a transcript (the Library)"
    />
  );
}
