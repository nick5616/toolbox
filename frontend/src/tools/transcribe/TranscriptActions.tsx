import { IconButton, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { toAppError } from "@/lib/errors";
import { saveTextAs } from "@/lib/saveText";
import { basename } from "./options";

/** Copy and Save as… for a transcript .txt, read from disk on click (the file can be large). */
export function TranscriptActions({ path }: { path: string }) {
  const read = async (): Promise<string | null> => {
    try {
      // The whole file (ReadText allows up to 16 MB when asked explicitly).
      return await FilesService.ReadText(path, 16 << 20);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
      return null;
    }
  };
  return (
    <>
      <IconButton
        size="sm"
        icon="copy"
        label="Copy transcript"
        data-tip="Copy the whole transcript to the clipboard"
        onClick={() =>
          void read().then((t) => {
            if (t !== null) return copyText(t, { what: "transcript" });
          })
        }
      />
      <IconButton
        size="sm"
        icon="download"
        label="Save as…"
        data-tip="Save the transcript as a text file"
        onClick={() =>
          void read().then((t) => {
            if (t !== null) return saveTextAs(t, basename(path));
          })
        }
      />
    </>
  );
}
