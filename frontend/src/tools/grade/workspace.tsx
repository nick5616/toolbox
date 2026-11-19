/**
 * The Color Grader as a workspace (Phase 11 pattern, Phase 21 SPEC §E1): its
 * rail panels and its preview can open in click-in drawers or in their own
 * windows. The window with the tool open hosts the store; part windows hold
 * replicas whose listed actions run on the host. Panels that pick files, call
 * a model or submit jobs are inline-only (`poppable: false`).
 */
import { defineWorkspace } from "@/workspace";
import { ReadPanel, VibePanel } from "./AiPanels";
import { ExportPanel, FilesPanel } from "./FilesExportPanels";
import { LookPanel } from "./LookPanel";
import { ChaosPanel, MotionPanel, StealPanel } from "./MorePanels";
import { GradePreview } from "./Preview";
import { RegionsPanel } from "./RegionsPanel";
import { BRIDGED_ACTIONS, MODULE_ID, pickGradeValues, useGrade, type GradeBridgeValues, type GradeState } from "./store";


export function applyGradeValues(store: { setState(p: Partial<GradeState>): void }, v: Partial<GradeBridgeValues>): void {
  const patch: Partial<GradeState> = { ...v };
  if (Object.keys(patch).length) store.setState(patch);
}

export const gradeWorkspace = defineWorkspace<GradeState, GradeBridgeValues>({
  moduleId: MODULE_ID,
  store: useGrade,
  bridge: { pick: pickGradeValues, apply: applyGradeValues, actions: BRIDGED_ACTIONS },
  isOpen: (s) => s.selected !== "",
  panels: [
    { id: "files", title: "Files", icon: "images", tip: "The pictures and videos to grade; every file gets the same look", component: FilesPanel, drawerWidth: 360, poppable: false },
    { id: "look", title: "Look", icon: "sliders-horizontal", tip: "The steps of the current look: turn each on or off, set how much, where, and in what order", component: LookPanel, drawerWidth: 400, width: 420, height: 720 },
    { id: "vibe", title: "Vibe", icon: "wand-sparkles", tip: "Describe a look in words and the local chat model writes it", component: VibePanel, drawerWidth: 380, poppable: false },
    { id: "read", title: "Read the picture", short: "Read", icon: "scan-eye", tip: "The vision model suggests 6 looks that fit this picture", component: ReadPanel, drawerWidth: 380, poppable: false },
    { id: "regions", title: "Regions", icon: "layers", tip: "Depth, subject and people maps, so a step can apply to just part of the picture", component: RegionsPanel, drawerWidth: 380, poppable: false },
    { id: "steal", title: "Steal a look", short: "Steal", icon: "pipette", tip: "Match the colours of a reference picture", component: StealPanel, drawerWidth: 360, poppable: false },
    { id: "chaos", title: "Chaos", icon: "dices", tip: "A random look from a seed; lock the steps you want to keep", component: ChaosPanel, drawerWidth: 340, width: 340, height: 520 },
    { id: "motion", title: "Motion", icon: "activity", tip: "Make a video's look move, and sync it to the beat", component: MotionPanel, drawerWidth: 380, width: 380, height: 560 },
    { id: "export", title: "Export", icon: "download", tip: "Save the graded files, keep the look, or write a .cube LUT", component: ExportPanel, drawerWidth: 380, poppable: false },
  ],
  preview: { title: "Preview", icon: "palette", tip: "The graded preview in its own window", component: GradePreview, width: 960, height: 640, mirror: true },
});
