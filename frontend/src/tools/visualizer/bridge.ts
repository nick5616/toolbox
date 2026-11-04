/**
 * The Visualizer's store bridge (Phase 10): the view hosts it while the tool is
 * open; the pop-out preview (`visualizer.preview`) holds a replica.
 *
 * Replicated: the song, mode, analyze options, the analysis ref, the design,
 * the preview shape, the render seed and the playhead. Not replicated: the
 * analysis itself (a replica loads it from the ref's cache). The replica plays
 * the song itself and reports its playhead back (`setPlayheadMs`), so the
 * host's Song Map and reaction meters keep following.
 */
import { useEffect } from "react";
import type { StoreApi } from "zustand";
import type { AnalysisRef, AnalyzeOptions } from "@/lib/api";
import { hostBridge, replicaBridge, type BridgeSpec, type BridgeTransport } from "@/state/bridge";
import type { Show } from "@/viz/types";
import { useVisualizer, type VisualizerState } from "./store";

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

export const VISUALIZER_BRIDGE = "visualizer";

export const visualizerBridgeSpec: BridgeSpec<VisualizerState, VisualizerBridgeValues> = {
  name: VISUALIZER_BRIDGE,
  pick: (s) => ({ input: s.input, isVideo: s.isVideo, mode: s.mode, analyze: s.analyze, ref: s.ref, show: s.show, aspect: s.aspect, renderSeed: s.renderSeed, playheadMs: s.playheadMs }),
  apply: (store: StoreApi<VisualizerState>, v) => store.setState(v),
  actions: ["setPlayheadMs"],
};

/** Part windows: mirror the host's store. Returns dispose. */
export function startVisualizerReplica(transport?: BridgeTransport): () => void {
  return replicaBridge(useVisualizer, visualizerBridgeSpec, transport ? { transport } : {});
}

/** Mount in the Visualizer view: answers part windows for as long as the tool is open. */
export function useVisualizerBridgeHost(): void {
  useEffect(() => hostBridge(useVisualizer, visualizerBridgeSpec), []);
}
