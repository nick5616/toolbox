/**
 * The editor as a workspace (Phase 11 port of the Phase 10 editor parts): the
 * editor's own panels plus the tool's (`EditorProfile.panels`), the live
 * preview part and the store bridge, all through `defineWorkspace`.
 *
 * Two tools (Video Editor, Edit Studio) share one store per window, so both
 * workspaces use the same channels (`editor`, `editor-focus`): a panel popped
 * out of one keeps working when the main window switches to the other. Call
 * `defineEditorWorkspace(profile)` in the tool's `workspace.ts`.
 */
import type { ReactNode } from "react";
import { bridgeOf, defineWorkspace, getWorkspace, type Workspace } from "@/workspace";
import { editorBridgeName, editorBridgeSpec, enterReplicaMode, focusBridgeSpec, type EditorBridgeValues } from "./bridge";
import { PreviewPart, useEditorReplica } from "./editorParts";
import { useEditorFocus } from "./focus";
import { EDITOR_PANELS } from "./panelDefs";
import type { EditorProfile } from "./profile";
import { EditorProfileProvider } from "./profileContext";
import { useEditStudio, type EditStudioState } from "./store";

/** Defines the profile's tool workspace (once per module): panels, preview part, bridge. Returns it. */
export function defineEditorWorkspace(profile: EditorProfile): Workspace {
  const existing = getWorkspace(profile.moduleId);
  if (existing) return existing;
  const { name: _name, ...bridge } = editorBridgeSpec(profile.moduleId);
  function Wrap({ children }: { children: ReactNode }) {
    return <EditorProfileProvider profile={profile}>{children}</EditorProfileProvider>;
  }
  return defineWorkspace<EditStudioState, EditorBridgeValues>({
    moduleId: profile.moduleId,
    store: useEditStudio,
    bridgeName: editorBridgeName(profile.moduleId),
    bridge,
    extraBridges: [bridgeOf(useEditorFocus, focusBridgeSpec(profile.moduleId))],
    // The host bridges from the moment a project is chosen; a replica renders once the project has loaded.
    isHosting: (s) => s.projectId !== null,
    isOpen: (s) => s.history !== null,
    wrap: Wrap,
    onConnect: enterReplicaMode,
    panelTip: "A panel of the open project",
    panels: [...EDITOR_PANELS, ...(profile.panels ?? [])],
    preview: { title: "Preview", icon: "monitor-play", tip: "The live preview of the open project", width: 960, height: 600, component: PreviewPart },
    useReplica: useEditorReplica,
  });
}
