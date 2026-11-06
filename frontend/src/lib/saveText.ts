import { toast } from "@/components/toast";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";

/**
 * Asks where to save text a tool produced and writes it there
 * (FilesService.SaveText; the dialog starts in the library). `filename` is
 * the suggested name with its extension. Resolves the saved path, or "" when
 * cancelled or failed (failures toast).
 */
export async function saveTextAs(text: string, filename: string): Promise<string> {
  try {
    const dst = await FilesService.SaveText(filename, text);
    if (dst) toast({ title: `Saved ${dst}`, tone: "success" });
    return dst;
  } catch (err) {
    toast({ title: "Couldn't save", description: toAppError(err).message, tone: "danger" });
    return "";
  }
}
