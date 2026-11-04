/**
 * The dialogs of the posts list (new, rename, delete), used by the Posts panel
 * and by the empty state. Each action runs on the host through the store.
 */
import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { NameDialog, NewPostDialog } from "./dialogs";
import { MEDIA_EXTS } from "./SourcesPanel";
import { usePostBuilder } from "./postStore";

type Dialog = { kind: "new" } | { kind: "rename"; id: string } | { kind: "delete"; id: string } | null;

export async function pickMediaFiles(): Promise<string[]> {
  try {
    return (await FilesService.PickWith("Choose photos and clips", MEDIA_EXTS, true)) ?? [];
  } catch (e) {
    const err = toAppError(e);
    toast({ tone: "danger", title: err.message, description: err.hint });
    return [];
  }
}

export interface PostDialogs {
  openNew: () => void;
  openRename: (id: string) => void;
  openDelete: (id: string) => void;
  node: ReactNode;
}

export function usePostDialogs(): PostDialogs {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newFiles, setNewFiles] = useState<string[]>([]);
  const posts = usePostBuilder((s) => s.posts);
  const st = usePostBuilder.getState;
  const close = useCallback(() => setDialog(null), []);

  const renameTarget = dialog?.kind === "rename" ? posts.find((p) => p.id === dialog.id) : undefined;
  const deleteTarget = dialog?.kind === "delete" ? posts.find((p) => p.id === dialog.id) : undefined;

  const node = (
    <>
      {dialog?.kind === "new" && (
        <NewPostDialog
          fileCount={newFiles.length}
          onPickFiles={() => void pickMediaFiles().then((p) => setNewFiles((cur) => [...cur, ...p.filter((x) => !cur.includes(x))]))}
          onClose={close}
          onCreate={(name, format, aspect) => {
            setDialog(null);
            void st().createPost(name, format, aspect, newFiles);
          }}
          onCreateFromFolder={(name, format, aspect, folder, subfolders) => {
            setDialog(null);
            void st().createFromFolder(name, format, aspect, folder, subfolders);
          }}
        />
      )}
      {renameTarget && (
        <NameDialog
          title="Rename post"
          initial={renameTarget.name}
          confirmLabel="Rename"
          onConfirm={(n) => {
            setDialog(null);
            void st().renamePost(renameTarget.id, n);
          }}
          onClose={close}
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this post?"
        body={deleteTarget ? `“${deleteTarget.name}” is removed from Post Builder. Your photos, compositions and exported files are not touched.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          const id = deleteTarget?.id;
          setDialog(null);
          if (id) void st().deletePost(id);
        }}
        onCancel={close}
      />
    </>
  );

  return {
    openNew: () => {
      setNewFiles([]);
      setDialog({ kind: "new" });
    },
    openRename: (id) => setDialog({ kind: "rename", id }),
    openDelete: (id) => setDialog({ kind: "delete", id }),
    node,
  };
}
