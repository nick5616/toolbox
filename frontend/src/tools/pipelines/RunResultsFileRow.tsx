import { OutputKind, type RunFile } from "@/lib/api";
import { ResultRow } from "@/tools/_kit";

export const KIND_ICON: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
  [OutputKind.KindOther]: "file",
};

/**
 * One file of a run as the kit's result row: draggable, double-click opens,
 * Send to always visible, Reveal / Open / Save a copy on hover and focus. A
 * file deleted as an in-between file shows as missing.
 */
export function RunFileRow({ file }: { file: RunFile }) {
  return (
    <ResultRow
      path={file.path}
      outputId={file.outputId || undefined}
      missing={file.missing}
      name={file.name || undefined}
      icon={KIND_ICON[file.kind] ?? "file"}
      moduleId="pipelines"
      meta={file.roleLabel || undefined}
    />
  );
}
