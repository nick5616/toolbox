/**
 * The Video Editor's workspace (Phase 11): its panels, `video-studio.preview`
 * and `video-studio.panel` parts and the editor store bridge. Loaded by
 * `parts/index.ts` (`loadPartHost`) and by the tool view, so part windows know the parts without mounting the tool.
 */
import { defineEditorWorkspace } from "@/editor/workspace";
import { VIDEO_PROFILE } from "./profile";

export const videoWorkspace = defineEditorWorkspace(VIDEO_PROFILE);
