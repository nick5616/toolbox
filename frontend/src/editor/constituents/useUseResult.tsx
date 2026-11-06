/**
 * What "Use" does with a constituent tool's result inside the editor (Phase 11
 * SPEC §6): check the file, then swap a clip's source or the music bed.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Button, ConfirmDialog, toast } from "@/components";
import { EditStudioService, FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { prepare } from "../sources/actions";
import { commit, currentDoc } from "../timeline/actions";
import { fileDuration } from "../timeline/songFile";
import { otherUsers, replaceBedFile, replaceEverywhere, replaceInClip } from "./replaceSource";

/** The first of `paths` when it still exists, else a toast and "". */
export async function existingResult(paths: string[]): Promise<string> {
  const path = paths[0] ?? "";
  if (!path) return "";
  try {
    const info = (await FilesService.Stat([path]))?.[0];
    if (info && info.exists && !info.isDir) return path;
  } catch {
    /* treated as gone */
  }
  toast({ title: "That file is gone", tone: "warn" });
  return "";
}

/** Swaps the clip's source for a result file (asks when other clips share it). Returns the dialog to render. */
export function useReplaceClipSource(clipId: string): { onUse: (paths: string[]) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ to: string; from: string; others: number } | null>(null);

  const apply = useCallback(
    async (from: string, to: string, everywhere: boolean) => {
      try {
        const info = (await EditStudioService.Probe([to]))?.[0];
        if (!info || info.error || (info.kind !== "video" && info.kind !== "image")) {
          toast({ title: "That file can't be read as a photo or video", tone: "warn" });
          return;
        }
        const cur = currentDoc();
        if (!cur) return;
        commit(everywhere ? replaceEverywhere(cur, from, to) : replaceInClip(cur, clipId, to));
        await prepare([to]);
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
      }
    },
    [clipId],
  );

  const onUse = useCallback(
    (paths: string[]) => {
      void (async () => {
        const to = await existingResult(paths);
        const doc = currentDoc();
        if (!to || !doc) return;
        const from = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.path ?? "";
        if (!from || from === to) return;
        const others = otherUsers(doc, clipId, from);
        if (others > 0) setPending({ to, from, others });
        else await apply(from, to, false);
      })();
    },
    [clipId, apply],
  );

  const dialog = pending ? (
    <ConfirmDialog
      open
      title="Replace the file in other clips too?"
      body={
        <>
          <p>{`${pending.others} other ${pending.others === 1 ? "clip uses" : "clips use"} the same file.`}</p>
          <Button
            size="sm"
            data-tip="Only this clip gets the new file; the others keep the original"
            onClick={() => {
              const p = pending;
              setPending(null);
              void apply(p.from, p.to, false);
            }}
          >
            Just this clip
          </Button>
        </>
      }
      confirmLabel="Replace in all"
      onConfirm={() => {
        const p = pending;
        setPending(null);
        void apply(p.from, p.to, true);
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;
  return { onUse, dialog };
}

/** Makes a stem the music bed (range, gain and fades kept). */
export async function useAsMusic(paths: string[]): Promise<void> {
  const to = await existingResult(paths);
  if (!to) return;
  try {
    const ms = await fileDuration(to);
    const doc = currentDoc();
    if (doc?.song) commit(replaceBedFile(doc, to, ms));
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}
