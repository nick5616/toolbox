/**
 * Edit Studio (Phase 10 SPEC §5): the Video Editor's shell with the music
 * layer (`./profile.tsx`) plugged in.
 */
import { EditorShell } from "@/editor/EditorShell";
import type { ToolViewProps } from "@/tools";
import { MUSIC_EDIT_PROFILE } from "./profile";
import "./workspace"; // registers the panel and preview parts the rail and click-ins look up

export default function EditStudioView({ moduleId }: ToolViewProps) {
  return <EditorShell moduleId={moduleId} profile={MUSIC_EDIT_PROFILE} />;
}
