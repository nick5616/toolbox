import type { PipelineEntry } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { openPipelineRunSheet } from "./dropRouting";

// --- pipelines ---
// Palette entries for Pipelines (SPEC.md §11.6).
export function pipelinesCommands(entries: readonly PipelineEntry[]): Command[] {
  const open = (tab: "pipelines" | "runs") => () => {
    usePipelines.getState().setTab(tab);
    useUI.getState().navigate("pipelines");
  };
  return [
    { id: "pipelines.open", title: "Open Pipelines", section: "Actions", icon: "workflow", keywords: ["workflow", "chain", "automation"], run: open("pipelines") },
    { id: "pipelines.new", title: "New pipeline…", section: "Actions", icon: "plus", keywords: ["workflow", "template", "create"], run: open("pipelines") },
    ...entries.map<Command>((e) => ({
      id: `pipelines.run.${e.pipeline.id}`,
      title: `Run pipeline: ${e.pipeline.name}`,
      section: "Actions",
      icon: "play",
      keywords: ["pipeline", "workflow"],
      run: () => openPipelineRunSheet(e.pipeline.id, []),
    })),
    { id: "pipelines.runs", title: "Show pipeline runs", section: "Actions", icon: "workflow", keywords: ["progress", "history"], run: open("runs") },
  ];
}
// --- end pipelines ---
