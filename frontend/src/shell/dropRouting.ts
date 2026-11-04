import { toast } from "@/components";
import type { FilesDropped } from "@/lib/api";
import { acceptsPath } from "@/tools/_kit/accepts";
import { isReady, useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { currentWindow } from "@/lib/windows";
// --- pipelines ---
import { PipelinesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { usePipelines } from "@/state/pipelines";
import { inputAccepted, mergeInputs } from "@/tools/pipelines/RunSheetModel";
// --- end pipelines ---
// --- post folders ---
import { FilesService } from "@/lib/api";
import { usePostDrop } from "@/tools/post-builder/store";
// --- end post folders ---

export const TOOL_DROP_PREFIX = "tool-drop:";

// --- pipelines ---
export const PIPELINE_DROP_PREFIX = "pipeline-drop:";
export const PIPELINE_RUN_PREFIX = "pipeline-run:";

/** Opens the Run sheet of a pipeline with these inputs, on the Pipelines page. */
export function openPipelineRunSheet(pipelineId: string, inputs: string[]): void {
  usePipelines.getState().openRunSheet(pipelineId, inputs);
  useUI.getState().navigate("pipelines");
}

/** A drop on a pipeline card (SPEC.md §11.6): start at once when nothing else is needed, else the Run sheet. */
function routePipelineDrop(id: string, paths: string[]): void {
  const entry = usePipelines.getState().entries.find((e) => e.pipeline.id === id);
  if (!entry) {
    useUI.getState().setDrop(null);
    return;
  }
  const accepted = paths.filter((p) => inputAccepted(entry.check.accepts, p));
  const noSecrets = (entry.check.secrets ?? []).length === 0;
  if (!entry.check.ready || !noSecrets || accepted.length === 0) {
    openPipelineRunSheet(id, paths);
    return;
  }
  const name = entry.pipeline.name;
  const skipped = paths.length - accepted.length;
  PipelinesService.Start({ pipelineId: id, inputs: accepted, secrets: {} })
    .then((run) => {
      usePipelines.getState().upsertRun(run);
      toast({
        tone: "success",
        title: `Started ${name} with ${accepted.length} ${accepted.length === 1 ? "file" : "files"}`,
        description: skipped > 0 ? `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} it can't use` : undefined,
        action: {
          label: "Show",
          onClick: () => {
            useUI.getState().navigate("pipelines");
            usePipelines.getState().showRun(run.id);
          },
        },
      });
    })
    .catch((e: unknown) => {
      const err = toAppError(e);
      toast({ tone: "danger", title: err.message, description: err.hint });
      openPipelineRunSheet(id, paths);
    });
}
// --- end pipelines ---

/** Hands the paths a ready tool accepts to it (toasting what it skipped); false if it takes none. */
function handToTool(moduleId: string, paths: string[]): boolean {
  const mod = useModules.getState().byId[moduleId];
  if (!mod || !isReady(mod)) return false;
  const exts = mod.accepts.extensions ?? [];
  if (!mod.accepts.any && exts.length === 0) return false; // takes no files (Pipelines, Dev Utilities…)
  const accepted = paths.filter((p) => acceptsPath(exts, p));
  if (accepted.length === 0) return false;
  const skipped = paths.length - accepted.length;
  useUI.getState().handOff({ moduleId: mod.id, inputs: accepted });
  if (skipped > 0) toast({ title: `Skipped ${skipped} unsupported ${skipped === 1 ? "file" : "files"}`, tone: "warn" });
  return true;
}

// --- post folders ---
/**
 * On the Post Builder page a drop with folders hands everything to the tool
 * (the view makes a post from the first folder); plain files are handed over
 * flagged as a drop, so the view adds them as source files, not slides.
 */
function routePostBuilderDrop(d: FilesDropped, paths: string[]): void {
  const ui = useUI.getState();
  const fallback = () => {
    const target = d.targetId ?? "";
    if (target.startsWith(TOOL_DROP_PREFIX) && handToTool(target.slice(TOOL_DROP_PREFIX.length), paths)) return;
    if (handToTool(ui.view, paths)) return;
    ui.setDrop(d);
  };
  const plain = () => {
    usePostDrop.getState().mark();
    const target = d.targetId ?? "";
    const handed =
      (target.startsWith(TOOL_DROP_PREFIX) && handToTool(target.slice(TOOL_DROP_PREFIX.length), paths)) || handToTool(ui.view, paths);
    if (handed) return;
    usePostDrop.getState().unmark();
    ui.setDrop(d);
  };
  FilesService.Stat(paths).then(
    (infos) => {
      if ((infos ?? []).some((i) => i.isDir)) {
        usePostDrop.getState().mark();
        useUI.getState().handOff({ moduleId: "post-builder", inputs: paths });
      } else {
        plain();
      }
    },
    () => fallback(),
  );
}
// --- end post folders ---

/** A drop belongs to the window whose key matches `drop.window` (the main window ⇔ ""). */
export function ownsDrop(d: Pick<FilesDropped, "window">, myKey: string = currentWindow().key): boolean {
  const target = d.window ?? "";
  return target === (myKey === "main" ? "" : myKey);
}

/**
 * Handles `app:files-dropped` (SPEC §3.5). A drop on a tool's own drop zone,
 * or anywhere on the page of the tool being shown, goes straight to that tool
 * when it is ready and accepts at least one path; anything else (the
 * Library, Settings, Pipelines, files the tool can't use) opens the chooser.
 */
export function routeFilesDropped(d: FilesDropped): void {
  if (!ownsDrop(d)) return;
  const ui = useUI.getState();
  const target = d.targetId ?? "";
  // --- pipelines ---
  if (target.startsWith(PIPELINE_DROP_PREFIX)) {
    routePipelineDrop(target.slice(PIPELINE_DROP_PREFIX.length), d.paths ?? []);
    return;
  }
  if (target.startsWith(PIPELINE_RUN_PREFIX)) {
    const id = target.slice(PIPELINE_RUN_PREFIX.length);
    const sheet = usePipelines.getState().runSheet;
    if (sheet && sheet.pipelineId === id) usePipelines.getState().setRunSheetInputs(mergeInputs(sheet.inputs, d.paths ?? []));
    else openPipelineRunSheet(id, d.paths ?? []);
    return;
  }
  // --- end pipelines ---
  const paths = d.paths ?? [];
  // --- post folders ---
  if (paths.length > 0 && (target === TOOL_DROP_PREFIX + "post-builder" || ui.view === "post-builder")) {
    routePostBuilderDrop(d, paths);
    return;
  }
  // --- end post folders ---
  // A drop on a tool's own drop zone, or anywhere on the page of the tool
  // being shown, goes to that tool when it takes at least one of the files.
  if (target.startsWith(TOOL_DROP_PREFIX) && handToTool(target.slice(TOOL_DROP_PREFIX.length), paths)) return;
  if (handToTool(ui.view, paths)) return;
  ui.setDrop(d);
}
