/**
 * The Photo Composer as a workspace (Phase 11, SPEC §5.1): its panels and its
 * preview can open in click-in drawers or in their own windows. The window with
 * the project open hosts the store; part windows hold replicas whose listed
 * actions run on the host. Decoded images are loaded per window.
 */
import type { StoreApi } from "zustand";
import type { Composition } from "@/lib/api";
import { newHistory } from "@/lib/history";
import { useShortcut } from "@/lib/shortcuts";
import type { PostSlideSeed } from "@/state/ui";
import { defineWorkspace } from "@/workspace";
import { ComposerPreview } from "./canvas";
import { useLoadComposerImages } from "./images";
import { BackgroundPanelView, CanvasPanelView, LayerPanelView, LayersPanelView, LayoutsPanelView, SourcesPanelView, TextPanelView } from "./panels";
import { MODULE_ID, useComposer, type BuildPhase, type ComposerState, type Pending } from "./store";
import type { SaveState } from "./useAutosave";

export type ComposerBridgeValues = {
  projectId: string | null;
  name: string;
  doc: Composition | null;
  /** The drag in progress (about 30 fps), so popped-out windows follow it. */
  live: Composition | null;
  undoDepth: number;
  redoDepth: number;
  saveState: SaveState;
  postSlide: PostSlideSeed | null;
  selectedId: string | null;
  multi: string[];
  editingId: string | null;
  adjustBg: boolean;
  zoom: number;
  cropId: string | null;
  pending: Record<string, Pending>;
  busyLabels: Record<string, string>;
  phase: BuildPhase;
  exporting: boolean;
};

/** The actions a replica forwards to the host: every argument is JSON. */
export const BRIDGED_ACTIONS = [
  "undo",
  "redo",
  "setName",
  "select",
  "setEditing",
  "setAdjustBg",
  "setZoom",
  "setCropId",
  "patchLayer",
  "setText",
  "deleteLayers",
  "duplicateLayer",
  "reorderLayer",
  "arrangeLayer",
  "setBackground",
  "chooseBackground",
  "chooseBackgroundFromLibrary",
  "setCanvas",
  "applyLayoutKind",
  "shuffleLayout",
  "addPhotos",
  "pickPhotos",
  "pickPhotosFromLibrary",
  "addText",
  "removeBackgrounds",
  "restoreOriginals",
  "replaceSource",
] as const satisfies readonly (keyof ComposerState)[];

export function pickComposerValues(s: ComposerState): ComposerBridgeValues {
  return {
    projectId: s.projectId,
    name: s.name,
    doc: s.history?.present ?? null,
    live: s.liveOut,
    undoDepth: s.history?.past.length ?? 0,
    redoDepth: s.history?.future.length ?? 0,
    saveState: s.saveState,
    postSlide: s.postSlide,
    selectedId: s.selectedId,
    multi: s.multi,
    editingId: s.editingId,
    adjustBg: s.adjustBg,
    zoom: s.zoom,
    cropId: s.cropId,
    pending: s.pending,
    busyLabels: s.busyLabels,
    phase: s.phase,
    exporting: s.exporting,
  };
}

/**
 * Writes received values into a replica. Only the history's depths matter to a
 * replica (undo and redo run on the host), so it's rebuilt around the document.
 */
export function applyComposerValues(store: StoreApi<ComposerState>, v: Partial<ComposerBridgeValues>): void {
  const cur = store.getState();
  const { doc, undoDepth, redoDepth, ...rest } = v;
  const patch: Partial<ComposerState> = { ...rest };
  if (doc !== undefined || undoDepth !== undefined || redoDepth !== undefined) {
    const present = doc !== undefined ? doc : (cur.history?.present ?? null);
    if (!present) patch.history = null;
    else {
      const past = undoDepth ?? cur.history?.past.length ?? 0;
      const future = redoDepth ?? cur.history?.future.length ?? 0;
      patch.history = { ...newHistory(present), past: new Array<Composition>(past).fill(present), future: new Array<Composition>(future).fill(present) };
    }
  }
  if (Object.keys(patch).length) store.setState(patch);
}

function useReplica(): void {
  const doc = useComposer((s) => s.history?.present ?? null);
  useLoadComposerImages(doc, false);
  useShortcut("Mod+Z", () => useComposer.getState().undo());
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => useComposer.getState().redo());
}

export const composerWorkspace = defineWorkspace<ComposerState, ComposerBridgeValues>({
  moduleId: MODULE_ID,
  store: useComposer,
  bridge: { pick: pickComposerValues, apply: applyComposerValues, actions: BRIDGED_ACTIONS },
  isOpen: (s) => s.history !== null,
  panels: [
    { id: "sources", title: "Sources", icon: "images", tip: "Photos of the post this composition belongs to", component: SourcesPanelView, drawerWidth: 380, width: 380, height: 640 },
    { id: "layers", title: "Layers", icon: "layers", tip: "Everything on the canvas, top layer first; drag a row to reorder", component: LayersPanelView, drawerWidth: 360, width: 360, height: 640 },
    { id: "layer", title: "Layer", icon: "sliders-horizontal", tip: "Position, size, rotation, opacity, outline and shadow of the selected layer", component: LayerPanelView, drawerWidth: 380, width: 380, height: 720 },
    { id: "text", title: "Text style", icon: "case-sensitive", tip: "The words, font, colour and alignment of the selected text layer", component: TextPanelView, drawerWidth: 380, width: 380, height: 640 },
    { id: "layouts", title: "Layouts", icon: "layout-grid", tip: "Arrange all the photos automatically in a ready-made layout", component: LayoutsPanelView, drawerWidth: 340, width: 340, height: 420 },
    { id: "background", title: "Background", icon: "paint-bucket", tip: "What shows behind all the layers", component: BackgroundPanelView, drawerWidth: 380, width: 380, height: 640 },
    { id: "canvas", title: "Canvas", icon: "frame", tip: "The shape, size and file type of the finished picture", component: CanvasPanelView, drawerWidth: 360, width: 360, height: 360 },
  ],
  preview: { title: "Canvas", icon: "image", tip: "The live canvas in its own window", component: ComposerPreview, width: 900, height: 900, mirror: true },
  useReplica,
});
