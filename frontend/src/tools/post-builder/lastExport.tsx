/**
 * The post's last export, shown as a result row under the stage (Phase 14,
 * SPEC §1.C): the folder's name, Reveal/Open and Send to for its first file,
 * and a drag that carries every exported file. Host window only (a replica
 * never exports), not part of the bridged post state.
 */
import { create } from "zustand";
import { LastExport } from "@/editor/export/LastExport";
import { MODULE_ID } from "./postStore";

export interface PostExportResult {
  postId: string;
  folder: string;
  files: string[];
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
      name={r.folder.split(/[\\/]+/).filter(Boolean).pop() ?? r.folder}
      dragPaths={r.files.length > 0 ? r.files : [r.folder]}
      moduleId={MODULE_ID}
      note={r.files.length > 1 ? `${r.files.length} files` : undefined}
      onDismiss={() => useLastPostExport.getState().set(null)}
    />
  );
}
