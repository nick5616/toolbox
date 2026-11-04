/**
 * The Visualizer as a workspace (Phase 11, SPEC §5.5): `defineWorkspace` over
 * the Visualizer store. Panels: Source, Analysis, Export (they hold the file
 * picker and the render jobs, so they open inline only; a part window never
 * submits jobs). The designer's own sections live in the designer's rail
 * because they edit the design through the workspace's undo history.
 *
 * Preview part (`visualizer.preview`): the designer's preview in its own window.
 * Replicated: the song, mode, analysis options, the analysis ref, the design,
 * the preview shape, the render seed and the playhead. Not replicated: the
 * analysis itself (a replica loads it from the ref's cache). The replica plays
 * the song itself and reports its playhead back (`setPlayheadMs`), so the
 * host's Song Map and reaction meters keep following.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { Spinner } from "@/components";
import type { AnalysisRef, AnalyzeOptions } from "@/lib/api";
import { defineWorkspace } from "@/workspace";
import type { Show } from "@/viz/types";
import { useVisualizer, VISUALIZER_ID, type VisualizerState } from "./store";

export type VisualizerBridgeValues = {
  input: string | null;
  isVideo: boolean;
  mode: "full" | "overlay";
  analyze: AnalyzeOptions;
  ref: AnalysisRef | null;
  show: Show | null;
  aspect: number;
  renderSeed: number;
  playheadMs: number;
};

export const visualizerBridge = {
  pick: (s: VisualizerState): VisualizerBridgeValues => ({ input: s.input, isVideo: s.isVideo, mode: s.mode, analyze: s.analyze, ref: s.ref, show: s.show, aspect: s.aspect, renderSeed: s.renderSeed, playheadMs: s.playheadMs }),
  apply: (store: { setState: (v: Partial<VisualizerState>) => void }, v: Partial<VisualizerBridgeValues>) => store.setState(v),
  actions: ["setPlayheadMs"] as const,
};

/** A panel or preview loaded on first use: part windows import this file, not the heavy views. */
function lazyBody(load: () => Promise<{ default: ComponentType }>): ComponentType {
  const Body = lazy(load);
  return function LazyBody() {
    return (
      <Suspense fallback={<Spinner size={18} label="Loading" />}>
        <Body />
      </Suspense>
    );
  };
}

export const visualizerWorkspace = defineWorkspace({
  moduleId: VISUALIZER_ID,
  store: useVisualizer,
  bridge: { pick: visualizerBridge.pick, apply: visualizerBridge.apply, actions: [...visualizerBridge.actions] },
  isOpen: (s) => s.input !== null,
  panels: [
    { id: "source", title: "Source", icon: "music", tip: "The song or video: change the file, and for a video whether the visuals go over it", component: lazyBody(() => import("./SourcePanel")), drawerWidth: 420, poppable: false },
    { id: "analysis", title: "Analysis", icon: "audio-lines", tip: "Words, instruments and mood: what the song is analysed for, and analyse again", component: lazyBody(() => import("./AnalysisPanel")), drawerWidth: 440, poppable: false },
    { id: "export", title: "Export", icon: "film", tip: "Size, quality, range and sound; a short preview and the full render", component: lazyBody(() => import("./ExportPanel")), drawerWidth: 460, poppable: false },
  ],
  preview: {
    title: "Preview",
    icon: "monitor",
    tip: "The live preview of the design, with its own player",
    width: 960,
    height: 640,
    component: lazyBody(() => import("./PreviewPart")),
  },
});

export const PREVIEW_PART = visualizerWorkspace.previewPart;
