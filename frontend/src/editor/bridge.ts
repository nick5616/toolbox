/**
 * The editor's store bridge (Phase 10, SPEC §5.5 WP-E4). The window that has a
 * project open (main or a tool window) is the host; part windows (the preview,
 * a popped-out panel) hold replicas of the editor store and the focus store.
 *
 * Replicated: the document (as `project`), undo/redo depths, selection,
 * playhead, view state, the analysis ref, source/matte/interp states and
 * their /media URLs. Not replicated: the analysis itself (a replica loads it
 * from the ref), job IDs and setup flags. Replica actions run on the host.
 */
import { useEffect } from "react";
import type { StoreApi } from "zustand";
import type { AnalysisRef, EditMatteState, EditSourceState, EditStream } from "@/lib/api";
import { currentWindow } from "@/lib/windows";
import { hostBridge, replicaBridge, type BridgeSpec, type BridgeTransport } from "@/state/bridge";
import type { NormalProject } from "@/viz/edit/defaults";
import type { MarkerLane } from "@/viz/edit/types";
import { newHistory } from "@/lib/history";
import { useEditorFocus, type FocusState } from "./focus";
import type { EditorFocus } from "./profile";
import { useEditStudio, type AnalysisState, type EditStudioState, type SaveState, type Selection } from "./store";

export type EditorBridgeValues = {
  projectId: string | null;
  name: string;
  project: NormalProject | null;
  undoDepth: number;
  redoDepth: number;
  saveState: SaveState;
  selection: Selection;
  playheadMs: number;
  playing: boolean;
  activeLane: MarkerLane;
  snap: boolean;
  pps: number;
  scrollMs: number;
  rightPanel: "inspector" | "captions";
  safeZones: boolean;
  analysisRef: AnalysisRef | null;
  analysisState: AnalysisState;
  sources: Record<string, EditSourceState>;
  mattes: Record<string, EditMatteState>;
  interps: Record<string, EditStream>;
  urls: Record<string, string>;
  dialog: EditStudioState["dialog"];
};

/** Channel name of a tool's editor store bridge. */
// One channel for the editor family: the Video Editor and Edit Studio share one
// store per window (SPEC §5.2), so a panel popped out from either keeps working
// when the main window switches between the two tools.
export const editorBridgeName = (_moduleId: string): string => "editor";
export const focusBridgeName = (_moduleId: string): string => "editor-focus";

export function editorBridgeSpec(moduleId: string): BridgeSpec<EditStudioState, EditorBridgeValues> {
  return {
    name: editorBridgeName(moduleId),
    pick: (s) => ({
      projectId: s.projectId,
      name: s.name,
      project: s.history?.present ?? null,
      undoDepth: s.history?.past.length ?? 0,
      redoDepth: s.history?.future.length ?? 0,
      saveState: s.saveState,
      selection: s.selection,
      playheadMs: s.playheadMs,
      playing: s.playing,
      activeLane: s.activeLane,
      snap: s.snap,
      pps: s.pps,
      scrollMs: s.scrollMs,
      rightPanel: s.rightPanel,
      safeZones: s.safeZones,
      analysisRef: s.analysisRef,
      analysisState: s.analysisState,
      sources: s.sources,
      mattes: s.mattes,
      interps: s.interps,
      urls: s.urls,
      dialog: s.dialog,
    }),
    apply: (store, v) => applyEditorValues(store, v),
    actions: ["edit", "undo", "redo", "select", "setPlayhead", "setPlaying", "setActiveLane", "setSnap", "setView", "setRightPanel", "setSafeZones", "openDialog", "setName"],
  };
}

/**
 * Writes received values into a replica store. The history is rebuilt as
 * `{past: [d placeholders], present, future: [d placeholders]}`: only the
 * depths matter to a replica (undo/redo run on the host).
 */
export function applyEditorValues(store: StoreApi<EditStudioState>, v: Partial<EditorBridgeValues>): void {
  const cur = store.getState();
  const { project, undoDepth, redoDepth, ...rest } = v;
  const patch: Partial<EditStudioState> = {};
  for (const k of Object.keys(rest) as (keyof typeof rest)[]) {
    (patch as Record<string, unknown>)[k] = rest[k];
  }
  if (project !== undefined || undoDepth !== undefined || redoDepth !== undefined) {
    const present = project !== undefined ? project : (cur.history?.present ?? null);
    if (!present) patch.history = null;
    else {
      const past = undoDepth ?? cur.history?.past.length ?? 0;
      const future = redoDepth ?? cur.history?.future.length ?? 0;
      patch.history = { ...newHistory(present), past: new Array<NormalProject>(past).fill(present), future: new Array<NormalProject>(future).fill(present) };
    }
  }
  if (v.analysisRef !== undefined && (v.analysisRef?.key ?? "") !== (cur.analysisRef?.key ?? "")) patch.analysis = null;
  if (Object.keys(patch).length) store.setState(patch);
}

export function focusBridgeSpec(moduleId: string): BridgeSpec<FocusState, { focus: EditorFocus }> {
  return {
    name: focusBridgeName(moduleId),
    pick: (s) => ({ focus: s.focus }),
    apply: (store, v) => store.setState(v),
    actions: ["setFocus"],
  };
}

let replicaMode = false;

/** Whether this window holds a replica of the editor (a part window): it never saves, submits jobs or runs the host's data loading. */
export function isReplicaWindow(): boolean {
  return replicaMode || currentWindow().kind === "part";
}

/** Test hook. */
export function setReplicaModeForTest(on: boolean): void {
  replicaMode = on;
}

export interface BridgeOverrides {
  editor?: BridgeTransport;
  focus?: BridgeTransport;
}

/** Part windows: replicate the editor and focus stores from the host. Returns dispose. */
export function startEditorReplica(moduleId: string, transports: BridgeOverrides = {}): () => void {
  replicaMode = true;
  const a = replicaBridge(useEditStudio, editorBridgeSpec(moduleId), transports.editor ? { transport: transports.editor } : {});
  const b = replicaBridge(useEditorFocus, focusBridgeSpec(moduleId), transports.focus ? { transport: transports.focus } : {});
  return () => {
    a();
    b();
    replicaMode = false;
  };
}

/** Starts the host while a project is open in this window (not in part windows); stops when it closes. */
export function startEditorBridgeHost(moduleId: string, transports: BridgeOverrides = {}): () => void {
  const a = hostBridge(useEditStudio, editorBridgeSpec(moduleId), transports.editor);
  const b = hostBridge(useEditorFocus, focusBridgeSpec(moduleId), transports.focus);
  return () => {
    a();
    b();
  };
}

/** Mount in the editor: hosts the store bridge for pop-out parts while a project is open. */
export function useEditorBridgeHost(moduleId: string): void {
  const open = useEditStudio((s) => s.projectId !== null);
  useEffect(() => {
    if (!open || isReplicaWindow()) return;
    return startEditorBridgeHost(moduleId);
  }, [open, moduleId]);
}
