/**
 * Pipelines as a workspace (Phase 11, SPEC §5.6): the draft store is mirrored
 * to part windows, so Step, Triggers, Runs and About pop out and stay live.
 * No preview part. Actions run on the host: a replica never saves a pipeline
 * or starts a run.
 */
import type { BridgeSpec } from "@/state/bridge";
import { defineWorkspace } from "@/workspace";
import { useDraft, type DraftState } from "./draftStore";
import { AboutPanel, RunHistoryPanel, StepPanel, TriggersPanel } from "./panels";

type Shared = Pick<
  DraftState,
  "pipelineId" | "draft" | "check" | "catalog" | "stepId" | "watchMessage" | "runText" | "runCount"
>;

export const pipelinesBridge: Omit<BridgeSpec<DraftState, Shared>, "name"> = {
  pick: (s) => ({
    pipelineId: s.pipelineId,
    draft: s.draft,
    check: s.check,
    catalog: s.catalog,
    stepId: s.stepId,
    watchMessage: s.watchMessage,
    runText: s.runText,
    runCount: s.runCount,
  }),
  apply: (store, values) => store.setState(values),
  actions: ["select", "patchStep", "keepTouched", "removeStep", "duplicateStep", "setName", "setDescription", "setWatchEnabled", "chooseFolder", "openRuns", "undo", "redo"],
};

export const pipelinesWorkspace = defineWorkspace<DraftState, Shared>({
  moduleId: "pipelines",
  store: useDraft,
  bridge: pipelinesBridge,
  isOpen: (s) => s.draft !== null,
  panels: [
    { id: "step", title: "Step", icon: "sliders-horizontal", tip: "The options of the selected step", component: StepPanel, drawerWidth: 400, width: 420, height: 720 },
    { id: "triggers", title: "Triggers", icon: "eye", tip: "Ways a run can start besides pressing Run, like watching a folder", component: TriggersPanel, width: 400, height: 360 },
    { id: "runs", title: "Runs", icon: "history", tip: "This pipeline's earlier runs", component: RunHistoryPanel, width: 400, height: 240 },
    { id: "about", title: "About", icon: "info", tip: "The pipeline's name and description", component: AboutPanel, width: 400, height: 300 },
  ],
});
