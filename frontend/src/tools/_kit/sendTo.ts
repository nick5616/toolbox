import type { MenuItem } from "@/components";
import { openToolItems } from "@/lib/openTool";
import { toolAction } from "@/lib/toolActions";
import { isReady, type ModuleView } from "@/state/modules";
import { openPipelineRunSheet } from "@/shell/dropRouting";
import { usePipelines } from "@/state/pipelines";
import { acceptsPath } from "./accepts";

/** True when a tool takes `path` as an input file (an `any` tool, or one with a matching extension). */
export function moduleTakesFile(m: ModuleView, path: string): boolean {
  if (m.accepts.any) return true;
  return m.accepts.extensions.length > 0 && acceptsPath(m.accepts.extensions, path);
}

/** "Pipeline: <name>" items for the saved pipelines that take the file `path`. */
export function pipelineSendToItems(path: string): MenuItem[] {
  return usePipelines
    .getState()
    .entries.filter((e) => {
      const a = e.check.accepts;
      if (a.any) return true;
      const exts = a.extensions ?? [];
      return exts.length > 0 && acceptsPath(exts, path);
    })
    .map((e) => ({
      id: `pipeline:${e.pipeline.id}`,
      label: `Pipeline: ${e.pipeline.name}`,
      icon: "workflow",
      tip: "Run this saved pipeline on this file",
      onSelect: () => openPipelineRunSheet(e.pipeline.id, [path]),
    }));
}

/**
 * "Send to" menu items for one result file (SPEC §4.2): every ready, visible
 * tool that accepts it except `currentId`, each as "<Tool>" and
 * "<Tool> (new window)", "Add to post…" for what Post Builder takes
 * (images and videos), and "Pipeline: <name>" for each saved pipeline that
 * takes the file.
 */
export function sendToMenuItems(path: string, currentId: string, modules: readonly ModuleView[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const m of modules) {
    if (m.id === currentId || m.id === "post-builder" || m.hidden || !isReady(m) || !moduleTakesFile(m, path)) continue;
    openToolItems(m.id, [path], "send").forEach((it, i) =>
      items.push({ id: it.id, label: i === 0 ? m.name : `${m.name} (new window)`, icon: i === 0 ? m.icon : "app-window", tip: it.tip, onSelect: it.onSelect }),
    );
  }
  const post = modules.find((m) => m.id === "post-builder");
  if (post && isReady(post) && currentId !== post.id && acceptsPath(post.accepts.extensions, path) && post.accepts.extensions.length > 0) {
    items.push({ id: "add-to-post", label: "Add to post…", icon: "gallery-horizontal-end", tip: "Make a post slide from this file", onSelect: () => void toolAction("addToPost")(path) });
  }
  return [...items, ...pipelineSendToItems(path)];
}
