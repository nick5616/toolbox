/**
 * The post's last export, shown as a result row under the stage (Phase 14,
 * SPEC §1.C): the folder's name, Reveal/Open/Save a copy and Send to for its
 * first file, Open folder, and a drag that carries every exported file. Host window only (a replica
 * never exports), not part of the bridged post state.
 */
import { create } from "zustand";
import { IconButton, toast } from "@/components";
import { LastExport } from "@/editor/export/LastExport";
import { LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { MODULE_ID } from "./postStore";

export interface PostExportResult {
  postId: string;
  folder: string;
  files: string[];
  /** Library output id of the first file (enables Open). */
  outputId?: string;
}

interface State {
  result: PostExportResult | null;
  set(r: PostExportResult | null): void;
}

export const useLastPostExport = create<State>((set) => ({ result: null, set: (result) => set({ result }) }));

/** The row, for the open post only. */
export function PostExportRow({ postId }: { postId: string }) {
  const r = useLastPostExport((s) => s.result);
  if (!r || r.postId !== postId) return null;
  const first = r.files[0] ?? r.folder;
  return (
    <LastExport
      label="Post exported"
      icon="check"
      path={first}
      outputId={r.outputId}
      name={r.folder.split(/[\\/]+/).filter(Boolean).pop() ?? r.folder}
      dragPaths={r.files.length > 0 ? r.files : [r.folder]}
      moduleId={MODULE_ID}
      note={r.files.length > 1 ? `${r.files.length} files` : undefined}
      extra={
        <IconButton
          size="sm"
          icon="folder"
          label="Open folder"
          data-tip="Open the folder with every file of this export"
          onClick={() => void LibraryService.RevealPath(r.folder).catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }))}
        />
      }
      onDismiss={() => useLastPostExport.getState().set(null)}
    />
  );
}
