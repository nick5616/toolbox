import { toast } from "@/components";
import type { FilesDropped } from "@/lib/api";
import { acceptsPath } from "@/tools/_kit/accepts";
import { isReady, useModules } from "@/state/modules";
import { useUI } from "@/state/ui";

export const TOOL_DROP_PREFIX = "tool-drop:";

/**
 * Handles `app:files-dropped` (SPEC §3.5). A drop on a tool's own drop zone
 * goes straight to that tool when it is ready and accepts at least one path;
 * anything else opens the chooser.
 */
export function routeFilesDropped(d: FilesDropped): void {
  const ui = useUI.getState();
  const target = d.targetId ?? "";
  if (target.startsWith(TOOL_DROP_PREFIX)) {
    const mod = useModules.getState().byId[target.slice(TOOL_DROP_PREFIX.length)];
    const paths = d.paths ?? [];
    if (mod && isReady(mod)) {
      const accepted = paths.filter((p) => acceptsPath(mod.accepts.extensions, p));
      if (accepted.length > 0) {
        const skipped = paths.length - accepted.length;
        ui.handOff({ moduleId: mod.id, inputs: accepted });
        if (skipped > 0) toast({ title: `Skipped ${skipped} unsupported ${skipped === 1 ? "file" : "files"}`, tone: "warn" });
        return;
      }
    }
  }
  ui.setDrop(d);
}
