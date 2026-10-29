import { toast } from "@/components/toast";
import { ClipboardService } from "@/lib/api";
import { toAppError } from "@/lib/errors";

/**
 * Copies plain text through Go (ClipboardService.CopyText) so Clipboard
 * History records it exactly once (SPEC.md §3.10). Shows "Copied" unless
 * `quiet`. Resolves false (with an error toast) when the copy failed.
 */
export async function copyText(text: string, opts: { quiet?: boolean; what?: string } = {}): Promise<boolean> {
  try {
    await ClipboardService.CopyText(text);
    if (!opts.quiet) toast({ title: opts.what ? `Copied ${opts.what}` : "Copied", tone: "success", duration: 2000 });
    return true;
  } catch (err) {
    toast({ title: "Couldn't copy", description: toAppError(err).message, tone: "danger" });
    return false;
  }
}
