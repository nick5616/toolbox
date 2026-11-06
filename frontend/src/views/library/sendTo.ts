import type { MenuItem } from "@/components";
import { ModulesService } from "@/lib/api";
import { openToolItems } from "@/lib/openTool";
import { isReady, useModules } from "@/state/modules";
// --- pipelines ---
import { usePipelines } from "@/state/pipelines";
import { inputAccepted } from "@/tools/pipelines/RunSheetModel";
import { openPipelineRunSheet } from "@/shell/dropRouting";
// --- end pipelines ---
// --- add to post ---
import { toolAction } from "@/lib/toolActions";
import { acceptsPath } from "@/tools/_kit/accepts";
// --- end add to post ---

/**
 * Ready modules that accept `path` (or the files in it), as menu items that hand the
 * file(s) off, plus pipelines that take at least one of them.
 */
export async function sendToItems(path: string | string[]): Promise<MenuItem[]> {
  const paths = Array.isArray(path) ? path : [path];
  const many = paths.length > 1;
  const res = await ModulesService.Match(paths);
  const tools: MenuItem[] = (res.matches ?? [])
    .filter((m) => isReady(m.module))
    .flatMap((m) => {
      const inputs = many && m.paths && m.paths.length > 0 ? m.paths : paths;
      const suffix = many ? ` (${inputs.length} files)` : "";
      // "Open in <tool>" plus "…(new window)"; names come from the match so they're right even before the store fills.
      return openToolItems(m.module.id, inputs, "send").map((it, i) => ({
        ...it,
        label: i === 0 ? `Open in ${m.module.name}${suffix}` : `Open in ${m.module.name} (new window)${suffix}`,
        icon: i === 0 ? m.module.icon : "app-window",
      }));
    });
  // --- pipelines ---
  const pipelines: MenuItem[] = usePipelines
    .getState()
    .entries.map((e) => ({ e, ok: paths.filter((p) => inputAccepted(e.check.accepts, p)) }))
    .filter(({ ok }) => ok.length > 0)
    .map(({ e, ok }) => ({
      id: `pipeline:${e.pipeline.id}`,
      label: `Pipeline: ${e.pipeline.name}`,
      icon: "workflow",
      onSelect: () => openPipelineRunSheet(e.pipeline.id, ok),
    }));
  // --- add to post ---
  const postModule = useModules.getState().byId["post-builder"];
  if (!many && postModule && isReady(postModule) && acceptsPath(postModule.accepts.extensions, paths[0] ?? "")) {
    tools.push({
      id: "add-to-post",
      label: "Add to post…",
      icon: "gallery-horizontal-end",
      onSelect: () => void toolAction("addToPost")(paths[0] ?? ""),
    });
  }
  // --- end add to post ---
  return pipelines.length > 0 ? [...tools, ...pipelines] : tools;
  // --- end pipelines ---
}
