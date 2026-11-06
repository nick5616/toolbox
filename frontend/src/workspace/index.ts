// The workspace kit (Phase 11, SPEC §3): store-backed panels that pop out, a
// poppable preview, a rail, a bar that never wraps and the studio layout.
export { bridgeOf, defineWorkspace, getWorkspace } from "./defineWorkspace";
export { OneLineBar, Spacer, StudioLayout, WorkspacePanel, WorkspacePreviewFrame, WorkspaceRail, fitBar, panelDrawerId, railFit } from "./components";
export type { OneLineBarProps, StudioLayoutProps, WorkspacePanelProps, WorkspaceRailProps } from "./components";
export type { ExtraBridge, ToolPanel, Workspace, WorkspacePreview, WorkspaceSpec } from "./types";
