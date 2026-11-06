/**
 * A launcher for one of the open tool's editor panels: the workspace's
 * `WorkspacePanel` with the workspace resolved from the profile, so editor
 * components (rail, selection bar) don't pass it around. Drawer ids come from
 * the workspace kit (`panel:<id>`).
 */
import { WorkspacePanel, panelDrawerId, type WorkspacePanelProps } from "@/workspace";
import { useEditorWorkspace } from "./profileContext";

export { panelDrawerId };

export type PanelClickInProps = Omit<WorkspacePanelProps, "ws">;

export function PanelClickIn(props: PanelClickInProps) {
  const ws = useEditorWorkspace();
  if (!ws) return null;
  return <WorkspacePanel ws={ws} {...props} />;
}
