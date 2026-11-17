/**
 * The Video Editor (Phase 10 SPEC §5): the multitrack editor in
 * `frontend/src/editor/` with the plain video profile.
 */
import { EditorShell } from "@/editor/EditorShell";
import type { ToolViewProps } from "@/tools";
import { VIDEO_PROFILE } from "./profile";
import "./workspace"; // registers the panel and preview parts the rail and click-ins look up

export default function VideoEditorView({ moduleId }: ToolViewProps) {
  return <EditorShell moduleId={moduleId} profile={VIDEO_PROFILE} />;
}
