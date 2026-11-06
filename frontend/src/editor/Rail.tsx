/**
 * The left rail (Phase 10 SPEC §5.5): one icon click-in launcher per panel
 * the tool puts at the top level, with the panel's name under its icon. It
 * never scrolls: what doesn't fit in the height goes into a "More" item. Since
 * Phase 11 this is the workspace kit's `WorkspaceRail` fed by the profile.
 */
import { WorkspaceRail } from "@/workspace";
import { useEditorProfile, useEditorWorkspace } from "./profileContext";
import { useProject } from "./store";

/** The Video Editor's rail: Media, Text, Music, Project. Profiles replace it with `profile.rail`. */
export const DEFAULT_RAIL: readonly string[] = ["media", "text", "music", "project"];

export function Rail() {
  const profile = useEditorProfile();
  const ws = useEditorWorkspace();
  const sources = useProject()?.sources.length ?? 0;
  if (!ws) return null;
  return <WorkspaceRail ws={ws} panels={profile.rail ?? DEFAULT_RAIL} badges={{ media: sources }} />;
}
