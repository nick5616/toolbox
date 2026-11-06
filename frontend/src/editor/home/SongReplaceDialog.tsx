/** "Use as the song?" for an audio file dropped on an open edit (Phase 9 SPEC §14.13). Rendered by the Sources panel, which is always on screen in the editor. */
import { ConfirmDialog, toast } from "@/components";
import { toAppError } from "@/lib/errors";
import { useAsSong } from "./createEdit";
import { useNewEditRequest } from "./newEditRequest";

export function SongReplaceDialog() {
  const path = useNewEditRequest((s) => s.songReplace);
  const name = path?.split(/[\\/]/).pop() ?? "";
  const close = () => useNewEditRequest.getState().askSong(null);
  return (
    <ConfirmDialog
      open={!!path}
      title="Use as the song?"
      confirmLabel="Use as the song"
      body={`"${name}" replaces the song. The edit's clips stay, and the song is analyzed again.`}
      onConfirm={() => {
        const p = path;
        close();
        if (p) void useAsSong(p).catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }));
      }}
      onCancel={close}
    />
  );
}
